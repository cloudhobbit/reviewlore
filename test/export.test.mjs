import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, cpSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { parseRuleFile, listGeneratedRules } from "../lib/rule-files.mjs";
import { planExport, applyExport, detectTargets } from "../lib/export.mjs";
import { writeSkills } from "../lib/skill-writer.mjs";

const ROOT = resolve(import.meta.dirname, "..");
const GALLERY = join(ROOT, "examples/real-repos/vitest/plugin");

function repo(extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), "export-"));
  cpSync(join(GALLERY, ".claude"), join(dir, ".claude"), { recursive: true });
  for (const [p, body] of Object.entries(extra)) {
    mkdirSync(dirname(join(dir, p)), { recursive: true });
    writeFileSync(join(dir, p), body);
  }
  return dir;
}
const exportTo = (dir, targets) => {
  const plan = planExport(listGeneratedRules(dir), dir, targets);
  applyExport(plan.steps, dir);
  return plan;
};
const changed = (plan) => plan.steps.filter((s) => s.action === "write" || s.action === "delete").map((s) => `${s.action} ${s.path}`);

test("parseRuleFile reads plugin rules and skips hand-written ones", () => {
  const rules = listGeneratedRules(GALLERY);
  assert.equal(rules.length, 6);
  const doc = rules.find((r) => r.id === "document-new-options-and-features");
  assert.equal(doc.title, "Document new options and features in the same PR");
  assert.deepEqual(doc.paths, ["packages/**/*.ts"]);
  assert.equal(doc.why, "Requested on 3 PRs by 3 reviewers.");
  assert.equal(doc.examples.length, 3);
  assert.deepEqual(Object.keys(doc.examples[0]), ["quote", "author", "pr", "url"]);
  assert.equal(parseRuleFile("# My rule\n\nDo it.\n", "pr-feedback-mine.md"), null, "no provenance");
  assert.equal(parseRuleFile(readFileSync(join(GALLERY, ".claude/rules", `pr-feedback-${doc.id}.md`), "utf-8"), "notes.md"), null, "wrong name");
});

test("parseRuleFile reads rules written by `run` too", () => {
  const dir = mkdtempSync(join(tmpdir(), "export-run-"));
  try {
    const items = [1, 2, 3].map((n) => ({ sentence: "Avoid any types in handlers.", author: `r${n}`, pr: n, url: `https://github.com/o/r/pull/${n}`, path: "src/a.ts", kind: "prohibition" }));
    writeSkills([{ label: ["any", "types"], kind: "prohibition", kinds: ["prohibition"], items, occurrences: 3, distinctAuthors: 3, distinctPRs: 3, paths: ["src/a.ts"], authors: ["r1", "r2", "r3"] }], { targetDir: dir });
    const [rule] = listGeneratedRules(dir);
    assert.ok(rule.title && rule.body);
    assert.equal(rule.examples.length, 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("export writes every target, is idempotent, and follows deleted rules", () => {
  const dir = repo();
  try {
    const first = exportTo(dir, ["copilot", "cursor", "agents", "review"]);
    assert.equal(changed(first).length, 6 + 6 + 1 + 2);
    const copilot = readFileSync(join(dir, ".github/instructions/pr-feedback-document-new-options-and-features.instructions.md"), "utf-8");
    assert.match(copilot, /^---\napplyTo: "packages\/\*\*\/\*\.ts"\n---\n<!-- Exported by reviewlore/);
    assert.match(copilot, /— @sheremet-va on PR #9475: https:\/\/github\.com\/vitest-dev\/vitest\/pull\/9475/);
    assert.match(readFileSync(join(dir, ".cursor/rules/pr-feedback-document-new-options-and-features.mdc"), "utf-8"), /globs: \["packages\/\*\*\/\*\.ts"\]\nalwaysApply: false/);
    assert.match(readFileSync(join(dir, "AGENTS.md"), "utf-8"), /<!-- reviewlore:start -->[\s\S]*### Document new options[\s\S]*Applies to: `packages\/\*\*\/\*\.ts`/);
    assert.match(readFileSync(join(dir, "REVIEW.md"), "utf-8"), /<!-- reviewlore:start -->\n@review-pr-feedback\.md\n<!-- reviewlore:end -->/);
    assert.match(readFileSync(join(dir, "review-pr-feedback.md"), "utf-8"), /Flag changes that go against these conventions/);

    assert.deepEqual(changed(exportTo(dir, ["copilot", "cursor", "agents", "review"])), [], "second run changes nothing");

    rmSync(join(dir, ".claude/rules/pr-feedback-document-new-options-and-features.md"));
    const after = changed(exportTo(dir, ["copilot", "cursor", "agents", "review"]));
    assert.ok(after.includes("delete .github/instructions/pr-feedback-document-new-options-and-features.instructions.md"));
    assert.ok(after.includes("delete .cursor/rules/pr-feedback-document-new-options-and-features.mdc"));
    assert.doesNotMatch(readFileSync(join(dir, "AGENTS.md"), "utf-8"), /Document new options/);

    // No rules left: exports and the REVIEW.md include go, the files stay.
    rmSync(join(dir, ".claude/rules"), { recursive: true });
    exportTo(dir, ["copilot", "cursor", "agents", "review"]);
    assert.deepEqual(readdirSync(join(dir, ".github/instructions")), []);
    assert.equal(existsSync(join(dir, "review-pr-feedback.md")), false);
    assert.doesNotMatch(readFileSync(join(dir, "REVIEW.md"), "utf-8"), /reviewlore/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("hand-written files and prose around managed blocks are never touched", () => {
  const handCursor = "---\ndescription: mine\n---\n# My own rule\n";
  const dir = repo({
    ".cursor/rules/pr-feedback-document-new-options-and-features.mdc": handCursor,
    ".cursor/rules/pr-feedback-something-else.mdc": "hand-written, same prefix\n",
    "AGENTS.md": "# Agents\n\nOur own guidance.\n",
  });
  try {
    const plan = exportTo(dir, ["cursor", "agents"]);
    assert.equal(readFileSync(join(dir, ".cursor/rules/pr-feedback-document-new-options-and-features.mdc"), "utf-8"), handCursor);
    assert.ok(existsSync(join(dir, ".cursor/rules/pr-feedback-something-else.mdc")), "not ours: not deleted");
    assert.ok(plan.warnings.some((w) => /pr-feedback-document-new-options-and-features\.mdc exists and wasn't written by export/.test(w)));
    const agents = readFileSync(join(dir, "AGENTS.md"), "utf-8");
    assert.ok(agents.startsWith("# Agents\n\nOur own guidance.\n\n<!-- reviewlore:start -->"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("REVIEW.md: no ninth include, and a size warning near the limit", () => {
  const includes = Array.from({ length: 8 }, (_, i) => `@doc${i}.md`).join("\n");
  const dir = repo({ "REVIEW.md": `# Review\n\n${includes}\n` });
  try {
    const plan = exportTo(dir, ["review"]);
    assert.doesNotMatch(readFileSync(join(dir, "REVIEW.md"), "utf-8"), /review-pr-feedback/);
    assert.ok(plan.warnings.some((w) => /already includes 8 files/.test(w)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const big = repo({ "REVIEW.md": "# Review\n\n@big.md\n", "big.md": "x".repeat(140_000) });
  try {
    assert.ok(exportTo(big, ["review"]).warnings.some((w) => /reads at most 150000/.test(w)));
  } finally {
    rmSync(big, { recursive: true, force: true });
  }
});

test("detectTargets picks the tools the repo uses; claude-md is opt-in and warns", () => {
  const dir = repo({ ".github/instructions/x.instructions.md": "x", "REVIEW.md": "# R\n" });
  try {
    assert.deepEqual(detectTargets(dir), ["copilot", "review"]);
    const plan = exportTo(dir, ["claude-md"]);
    assert.ok(plan.warnings.some((w) => /CLAUDE\.md loads in every session/.test(w)));
    assert.match(readFileSync(join(dir, "CLAUDE.md"), "utf-8"), /<!-- reviewlore:start -->/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("reviewlore export CLI: dry run writes nothing; --to is required", () => {
  const dir = repo();
  try {
    const bin = join(ROOT, "cli/reviewlore.mjs");
    const dry = spawnSync(process.execPath, [bin, "export", "--to", "copilot", "--target", dir, "--dry-run"], { encoding: "utf-8" });
    assert.equal(dry.status, 0, dry.stderr);
    assert.match(dry.stderr, /would write {2}\.github\/instructions\/pr-feedback-/);
    assert.equal(existsSync(join(dir, ".github")), false);
    const none = spawnSync(process.execPath, [bin, "export", "--target", dir], { encoding: "utf-8" });
    assert.equal(none.status, 1);
    assert.match(none.stderr, /--to is required/);
    const bad = spawnSync(process.execPath, [bin, "export", "--to", "copilt", "--target", dir], { encoding: "utf-8" });
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /unknown target "copilt"/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
