import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeRule, normalizeAll, relativeAge, pathGlobs } from "../lib/renderers/_common.mjs";

const baseCluster = {
  label: ["test", "missing", "edge"],
  occurrences: 4,
  weightedOccurrences: 5,
  distinctAuthors: 3,
  distinctPRs: 4,
  authors: ["alice", "bob", "carol"],
  paths: ["src/a.ts", "src/b.tsx"],
  kinds: ["request"],
  firstSeen: "2025-12-01T00:00:00Z",
  lastSeen: "2026-04-01T00:00:00Z",
  items: [
    { sentence: "Please add a test for the empty-array case.", author: "alice", pr: 1, url: "u1", path: "src/a.ts" },
    { sentence: "Missing test for null input.", author: "bob", pr: 2, url: "u2", path: "src/b.tsx" },
    { sentence: "Add tests for edge cases.", author: "carol", pr: 3, url: "u3", path: "src/a.ts" },
  ],
};

test("normalizeRule: heuristic path produces canonical Rule shape", () => {
  const r = normalizeRule(baseCluster);
  assert.equal(r.source, "heuristic");
  assert.ok(r.id);
  assert.ok(r.title);
  assert.ok(r.body);
  assert.match(r.why, /Recurred 4×/);
  assert.match(r.when_to_apply, /\.ts/);
  assert.equal(r.kind, "request");
  assert.deepEqual(r.globs, ["src/**/*.ts", "src/**/*.tsx"]);
  assert.equal(r.examples.length, 3);
});

test("normalizeRule: LLM-synthesised path uses synth fields", () => {
  const synth = {
    name: "Add tests for edge cases",
    rule: "Cover null, empty, and boundary inputs in every new function.",
    why: "These are the inputs reviewers consistently flag as missing.",
    when_to_apply: "Whenever adding or modifying a function with input branching.",
    kind: "prescription",
  };
  const r = normalizeRule(baseCluster, synth);
  assert.equal(r.source, "llm-synthesised");
  assert.equal(r.title, "Add tests for edge cases");
  assert.equal(r.kind, "prescription");
});

test("normalizeRule: LLM error falls back to heuristic + retains error message", () => {
  const r = normalizeRule(baseCluster, { _error: "rate limited" });
  assert.equal(r.source, "heuristic");
  assert.equal(r.synth_error, "rate limited");
});

test("normalizeRule: severity scales with weighted_occurrences", () => {
  assert.equal(normalizeRule({ ...baseCluster, weightedOccurrences: 2 }).severity, "consider");
  assert.equal(normalizeRule({ ...baseCluster, weightedOccurrences: 6 }).severity, "should");
  assert.equal(normalizeRule({ ...baseCluster, weightedOccurrences: 15 }).severity, "must");
});

test("normalizeRule: stable id across runs (deterministic from label tokens)", () => {
  const a = normalizeRule(baseCluster).id;
  const b = normalizeRule({ ...baseCluster, label: ["edge", "missing", "test"] }).id; // reordered
  assert.equal(a, b, "id should not depend on label ordering");
});

test("normalizeAll maps clusters and synth in order", () => {
  const out = normalizeAll([baseCluster, baseCluster], [null, { _error: "x" }]);
  assert.equal(out.length, 2);
  assert.equal(out[1].synth_error, "x");
});

test("relativeAge: bucket boundaries", () => {
  const now = new Date("2026-06-01T12:00:00Z");
  assert.equal(relativeAge("2026-06-01T11:00:00Z", now), "today");
  assert.equal(relativeAge("2026-05-31T11:00:00Z", now), "yesterday");
  assert.equal(relativeAge("2026-05-15T12:00:00Z", now), "17 days ago");
  assert.match(relativeAge("2026-03-01T12:00:00Z", now), /^3 months ago/);
  assert.match(relativeAge("2024-06-01T12:00:00Z", now), /^2 years ago/);
  assert.equal(relativeAge(null, now), undefined);
});

test("pathGlobs scopes to top-level dir (or package) + extension", () => {
  assert.deepEqual(
    pathGlobs(["packages/vitest/src/node/core.ts", "packages/vitest/src/a.ts", "test/cli/x.test.ts", "README.md", "docs/guide/intro"]),
    ["README.md", "docs/**", "packages/vitest/**/*.ts", "test/**/*.ts"],
  );
});

test("pathGlobs falls back to extension-only globs when comments span many places", () => {
  const paths = ["a/x.ts", "b/x.ts", "c/x.ts", "d/x.ts", "e/x.ts", "f/x.tsx"];
  assert.deepEqual(pathGlobs(paths), ["**/*.ts", "**/*.tsx"]);
  assert.deepEqual(pathGlobs([]), []);
});

test("pathGlobs ignores a leading ./", () => {
  assert.deepEqual(pathGlobs(["./src/a.ts"]), ["src/**/*.ts"]);
});
