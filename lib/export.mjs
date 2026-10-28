// `reviewlore export`: the reviewed rules in .claude/rules/pr-feedback-*.md
// (the source of truth) rendered for other AI reviewers and agents
// (docs/plans/16-one-ruleset-every-reviewer.md). A pure transform: no
// model, no network, deterministic output.
//
//   copilot    .github/instructions/pr-feedback-<id>.instructions.md (applyTo globs)
//   cursor     .cursor/rules/pr-feedback-<id>.mdc (globs)
//   agents     managed section in AGENTS.md
//   review     review-pr-feedback.md + an `@review-pr-feedback.md` line in REVIEW.md
//              (Claude Code Review)
//   claude-md  managed section in CLAUDE.md (opt-in: loaded in every session)
//
// Only files carrying EXPORT_MARKER, and our managed blocks, are ever
// rewritten or deleted; anything else with a clashing name is skipped.

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, unlinkSync, statSync } from "node:fs";
import { join, dirname } from "node:path";

export const TARGETS = ["copilot", "cursor", "agents", "review", "claude-md"];
const EXPORT_MARKER = "<!-- Exported by reviewlore";
const BLOCK_START = "<!-- reviewlore:start -->";
const BLOCK_END = "<!-- reviewlore:end -->";
const REVIEW_FILE = "review-pr-feedback.md";
// Claude Code Review: a root REVIEW.md may include up to 8 root-level files,
// 150,000 bytes combined (code.claude.com/docs/en/code-review-customize).
const REVIEW_MAX_INCLUDES = 8;
const REVIEW_MAX_BYTES = 150_000;

const marker = (rule) =>
  `${EXPORT_MARKER} from .claude/rules/${rule.file}. Edit that file and re-run \`reviewlore export\`; changes here are overwritten. -->`;
const blockMarker = `${EXPORT_MARKER} from .claude/rules/pr-feedback-*.md. Edit those and re-run \`reviewlore export\`. -->`;

const scope = (rule) => (rule.paths.length ? rule.paths.map((p) => `\`${p}\``).join(", ") : "all files");
const sources = (rule) => rule.examples.map((e) => `[PR #${e.pr}](${e.url})`).join(", ");
const yamlString = (s) => `"${String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

function examplesSection(rule) {
  return [
    "## Examples from PR review history",
    "",
    ...rule.examples.flatMap((e) => [`- > ${e.quote}`, `  — @${e.author} on PR #${e.pr}: ${e.url}`]),
  ].join("\n");
}

function ruleDocument(rule) {
  return [`# ${rule.title}`, "", rule.body, "", ...(rule.why ? [`**Why:** ${rule.why}`, ""] : []), examplesSection(rule), ""].join("\n");
}

// One section per rule, for files that hold them all.
function ruleSection(rule, heading = "###") {
  return [
    `${heading} ${rule.title}`,
    "",
    rule.body,
    "",
    `Applies to: ${scope(rule)}.${rule.why ? ` ${rule.why}` : ""} Sources: ${sources(rule)}.`,
    "",
  ].join("\n");
}

const renderCopilot = (rule) =>
  `---\napplyTo: ${yamlString(rule.paths.length ? rule.paths.join(",") : "**")}\n---\n${marker(rule)}\n\n${ruleDocument(rule)}`;

const renderCursor = (rule) =>
  [
    "---",
    `description: ${yamlString(rule.title)}`,
    ...(rule.paths.length ? [`globs: [${rule.paths.map(yamlString).join(", ")}]`, "alwaysApply: false"] : ["alwaysApply: true"]),
    "---",
    marker(rule),
    "",
    ruleDocument(rule),
  ].join("\n");

function managedBlock(title, intro, rules) {
  return [BLOCK_START, blockMarker, "", `## ${title}`, "", intro, "", ...rules.map((r) => ruleSection(r)), BLOCK_END].join("\n");
}

const AGENTS_INTRO = "Conventions reviewers have asked for repeatedly in this repository's pull requests. Each links to the review comments behind it.";
const REVIEW_INTRO = "Flag changes that go against these conventions. Each was asked for by several reviewers in this repository's pull requests; the links show where.";

// Insert, replace or remove our managed block in a shared file.
function upsertBlock(current, block, { header }) {
  const re = new RegExp(`${BLOCK_START}[\\s\\S]*?${BLOCK_END}\\n?`);
  if (current === null) return block ? `${header}${block}\n` : null;
  if (re.test(current)) return block ? current.replace(re, `${block}\n`) : current.replace(re, "").replace(/\n{3,}$/, "\n\n");
  return block ? `${current.trimEnd()}\n\n${block}\n` : current;
}

const read = (path) => (existsSync(path) ? readFileSync(path, "utf-8") : null);
const isOurs = (text) => text !== null && text.includes(EXPORT_MARKER);

// Per-rule files in `dir` named pr-feedback-<id><suffix>: write current
// rules, delete our files for rules that no longer exist.
function perRuleFiles(targetDir, dir, suffix, rules, render, target) {
  const steps = [];
  const wanted = new Set();
  for (const rule of rules) {
    const rel = `${dir}/pr-feedback-${rule.id}${suffix}`;
    wanted.add(rel);
    const content = render(rule);
    const existing = read(join(targetDir, rel));
    if (existing !== null && !isOurs(existing)) steps.push({ target, path: rel, action: "skip", reason: "exists and wasn't written by export" });
    else steps.push({ target, path: rel, action: existing === content ? "unchanged" : "write", content });
  }
  const abs = join(targetDir, dir);
  if (existsSync(abs)) {
    for (const f of readdirSync(abs).sort()) {
      const rel = `${dir}/${f}`;
      if (f.startsWith("pr-feedback-") && f.endsWith(suffix) && !wanted.has(rel) && isOurs(read(join(abs, f)))) {
        steps.push({ target, path: rel, action: "delete" });
      }
    }
  }
  return steps;
}

function sharedFile(targetDir, rel, block, header, target) {
  const current = read(join(targetDir, rel));
  const next = upsertBlock(current, block, { header });
  if (next === null || next === current) return [{ target, path: rel, action: "unchanged" }];
  return [{ target, path: rel, action: "write", content: next }];
}

function reviewSteps(targetDir, rules, warnings) {
  const steps = [];
  const fileContent = rules.length
    ? [blockMarker, "", "# Review checks from PR history", "", REVIEW_INTRO, "", ...rules.map((r) => ruleSection(r, "##"))].join("\n")
    : null;
  const existing = read(join(targetDir, REVIEW_FILE));
  if (existing !== null && !isOurs(existing)) {
    return [{ target: "review", path: REVIEW_FILE, action: "skip", reason: "exists and wasn't written by export" }];
  }
  if (fileContent === null) {
    if (existing !== null) steps.push({ target: "review", path: REVIEW_FILE, action: "delete" });
  } else {
    steps.push({ target: "review", path: REVIEW_FILE, action: existing === fileContent ? "unchanged" : "write", content: fileContent });
  }

  const reviewMd = read(join(targetDir, "REVIEW.md"));
  const outside = (reviewMd ?? "").replace(new RegExp(`${BLOCK_START}[\\s\\S]*?${BLOCK_END}`), "");
  const otherIncludes = outside.split("\n").filter((l) => /^@\S+\.md\s*$/.test(l.trim()));
  if (rules.length && otherIncludes.length >= REVIEW_MAX_INCLUDES) {
    warnings.push(`REVIEW.md already includes ${otherIncludes.length} files (Claude Code Review reads at most ${REVIEW_MAX_INCLUDES}); add "@${REVIEW_FILE}" yourself in place of one.`);
    return steps;
  }
  const block = rules.length ? `${BLOCK_START}\n@${REVIEW_FILE}\n${BLOCK_END}` : "";
  steps.push(...sharedFile(targetDir, "REVIEW.md", block, "# Review instructions\n\n", "review"));

  if (fileContent) {
    let bytes = Buffer.byteLength(fileContent) + Buffer.byteLength(reviewMd ?? "");
    for (const inc of otherIncludes) {
      const p = join(targetDir, inc.trim().slice(1));
      if (existsSync(p)) bytes += statSync(p).size;
    }
    if (bytes > REVIEW_MAX_BYTES * 0.9) {
      warnings.push(`REVIEW.md and its includes come to ${bytes} bytes; Claude Code Review reads at most ${REVIEW_MAX_BYTES}.`);
    }
  }
  return steps;
}

// Which targets the repo already uses (for --to auto). claude-md is never
// picked automatically: it loads the rules into every session.
export function detectTargets(targetDir) {
  const has = (p) => existsSync(join(targetDir, p));
  const out = [];
  if (has(".github/copilot-instructions.md") || has(".github/instructions")) out.push("copilot");
  if (has(".cursor")) out.push("cursor");
  if (has("AGENTS.md")) out.push("agents");
  if (has("REVIEW.md")) out.push("review");
  return out;
}

// Returns { steps: [{ target, path, action, content?, reason? }], warnings }.
export function planExport(rules, targetDir, targets) {
  const sorted = [...rules].sort((a, b) => a.id.localeCompare(b.id));
  const warnings = [];
  const steps = [];
  for (const target of targets) {
    if (target === "copilot") steps.push(...perRuleFiles(targetDir, ".github/instructions", ".instructions.md", sorted, renderCopilot, target));
    else if (target === "cursor") steps.push(...perRuleFiles(targetDir, ".cursor/rules", ".mdc", sorted, renderCursor, target));
    else if (target === "agents") {
      const block = sorted.length ? managedBlock("Conventions from PR review", AGENTS_INTRO, sorted) : "";
      steps.push(...sharedFile(targetDir, "AGENTS.md", block, "# AGENTS.md\n\n", target));
    } else if (target === "claude-md") {
      const block = sorted.length ? managedBlock("Conventions from PR review", AGENTS_INTRO, sorted) : "";
      steps.push(...sharedFile(targetDir, "CLAUDE.md", block, "", target));
      if (sorted.some((r) => r.paths.length)) {
        warnings.push("CLAUDE.md loads in every session, so path-scoped rules lose their scoping there; .claude/rules/ already gives Claude Code the scoped versions.");
      }
    } else if (target === "review") steps.push(...reviewSteps(targetDir, sorted, warnings));
    else throw new Error(`Unknown export target "${target}". Targets: ${TARGETS.join(", ")}, auto.`);
  }
  for (const s of steps) if (s.action === "skip") warnings.push(`${s.path} ${s.reason}; left it alone.`);
  return { steps, warnings: [...new Set(warnings)] };
}

export function applyExport(steps, targetDir) {
  for (const s of steps) {
    const abs = join(targetDir, s.path);
    if (s.action === "write") {
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, s.content, "utf-8");
    } else if (s.action === "delete") {
      unlinkSync(abs);
    }
  }
}
