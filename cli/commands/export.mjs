import { resolve } from "node:path";
import { existsSync, statSync } from "node:fs";
import { parseArgs, ArgsError } from "../../lib/args.mjs";
import { listGeneratedRules } from "../../lib/rule-files.mjs";
import { planExport, applyExport, detectTargets, TARGETS } from "../../lib/export.mjs";
import { findGitToplevel } from "../../lib/git-info.mjs";

const VERSION = "0.3.0";

const HELP = `reviewlore export v${VERSION}

Turns the rules in .claude/rules/pr-feedback-*.md (written by the Claude
Code plugin or \`reviewlore run\`) into other AI reviewers' formats, so one
reviewed ruleset reaches every tool. No network, no model; re-run after
editing or deleting a rule and its exports follow.

Usage:
  reviewlore export --to <targets> [--target <dir>] [--dry-run]

Targets (comma-separated):
  copilot     .github/instructions/pr-feedback-<id>.instructions.md, applyTo = the rule's paths
              (GitHub Copilot code review and coding agent)
  review      review-pr-feedback.md, included from REVIEW.md (Claude Code Review)
  agents      a managed section in AGENTS.md
  cursor      .cursor/rules/pr-feedback-<id>.mdc, globs = the rule's paths
  claude-md   a managed section in CLAUDE.md (opt-in: loaded in every session)
  auto        whichever of copilot / review / agents / cursor the repo already uses

Options:
  --to <targets>     Required. See above.
  --target <dir>     Repository root (default: the git root of the current directory)
  --dry-run          Show what would change; write nothing
  --version / --help

Only files this command wrote (they carry an "Exported by reviewlore" line)
and its own marked sections are ever changed or deleted.
`;

export async function main(argv) {
  let args;
  try {
    args = parseArgs(argv, {
      booleans: ["help", "version", "dry-run"],
      values: ["to", "target"],
      aliases: { h: "help", v: "version", t: "target" },
    });
  } catch (e) {
    if (e instanceof ArgsError) {
      process.stderr.write(`Error: ${e.message} Run \`reviewlore export --help\` for the options.\n`);
      return 1;
    }
    throw e;
  }
  if (args.help) {
    process.stdout.write(HELP);
    return 0;
  }
  if (args.version) {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }

  const targetDir = resolve(args.target ?? findGitToplevel(process.cwd()) ?? process.cwd());
  if (!existsSync(targetDir) || !statSync(targetDir).isDirectory()) {
    process.stderr.write(`Error: --target must be an existing directory: ${targetDir}\n`);
    return 1;
  }
  if (!args.to || args.to === true) {
    process.stderr.write("Error: --to is required, e.g. --to copilot,review or --to auto. Run `reviewlore export --help`.\n");
    return 1;
  }
  let targets = String(args.to).split(",").map((t) => t.trim()).filter(Boolean);
  if (targets.includes("auto")) {
    targets = [...new Set([...targets.filter((t) => t !== "auto"), ...detectTargets(targetDir)])];
    if (!targets.length) {
      process.stderr.write("No Copilot, Claude Code Review, AGENTS.md or Cursor files found in this repository; name the targets with --to.\n");
      return 0;
    }
    process.stderr.write(`Targets: ${targets.join(", ")}\n`);
  }
  const unknown = targets.filter((t) => !TARGETS.includes(t));
  if (unknown.length) {
    process.stderr.write(`Error: unknown target "${unknown[0]}". Targets: ${TARGETS.join(", ")}, auto.\n`);
    return 1;
  }

  const rules = listGeneratedRules(targetDir);
  if (!rules.length) {
    process.stderr.write("No reviewlore rules in .claude/rules/ (pr-feedback-*.md). Exports of earlier rules, if any, are removed.\n");
  }
  const { steps, warnings } = planExport(rules, targetDir, targets);
  const changes = steps.filter((s) => s.action === "write" || s.action === "delete");
  if (!args["dry-run"]) applyExport(steps, targetDir);

  const verb = args["dry-run"] ? { write: "would write", delete: "would delete" } : { write: "wrote", delete: "deleted" };
  process.stderr.write(`${rules.length} rule(s) from .claude/rules/ → ${targets.join(", ")}\n`);
  for (const s of changes) process.stderr.write(`  ${verb[s.action]}  ${s.path}\n`);
  if (!changes.length) process.stderr.write("  everything already up to date\n");
  for (const w of warnings) process.stderr.write(`⚠️  ${w}\n`);
  if (args["dry-run"]) process.stderr.write("(dry-run — no files written)\n");
  return 0;
}
