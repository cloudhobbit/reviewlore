import { test } from "node:test";
import assert from "node:assert/strict";
import { diffClusters, renderDiff } from "../lib/diff.mjs";

const mk = (label, occurrences, distinctAuthors = 2, distinctPRs = occurrences) => ({
  label, occurrences, distinctAuthors, distinctPRs,
});

test("diffClusters: identical inputs → all unchanged", () => {
  const a = [mk(["test", "missing"], 5), mk(["docs", "typo"], 3)];
  const d = diffClusters(a, a);
  assert.equal(d.added.length, 0);
  assert.equal(d.removed.length, 0);
  assert.equal(d.strengthened.length, 0);
  assert.equal(d.weakened.length, 0);
  assert.equal(d.unchanged.length, 2);
});

test("diffClusters: new clusters surface as added", () => {
  const prev = [mk(["test", "missing"], 5)];
  const curr = [mk(["test", "missing"], 5), mk(["docs", "typo"], 4)];
  const d = diffClusters(prev, curr);
  assert.equal(d.added.length, 1);
  assert.deepEqual(d.added[0].label, ["docs", "typo"]);
});

test("diffClusters: dropped clusters surface as removed", () => {
  const prev = [mk(["test", "missing"], 5), mk(["docs", "typo"], 3)];
  const curr = [mk(["test", "missing"], 5)];
  const d = diffClusters(prev, curr);
  assert.equal(d.removed.length, 1);
  assert.deepEqual(d.removed[0].label, ["docs", "typo"]);
});

test("diffClusters: matched cluster with higher counts is strengthened", () => {
  const prev = [mk(["test", "missing"], 3, 2)];
  const curr = [mk(["test", "missing"], 6, 4)];
  const d = diffClusters(prev, curr);
  assert.equal(d.strengthened.length, 1);
  assert.equal(d.strengthened[0].dOcc, 3);
  assert.equal(d.strengthened[0].dAuth, 2);
});

test("diffClusters: matched cluster with lower counts is weakened", () => {
  const prev = [mk(["test", "missing"], 6, 4)];
  const curr = [mk(["test", "missing"], 3, 2)];
  const d = diffClusters(prev, curr);
  assert.equal(d.weakened.length, 1);
});

test("diffClusters: cluster matches by token-set Jaccard even if label shifted", () => {
  // Previous: ["test", "missing", "edge"] vs current: ["test", "missing", "case"]
  // Jaccard = 2/4 = 0.5, which is the match threshold. They should match.
  const prev = [mk(["test", "missing", "edge"], 5)];
  const curr = [mk(["test", "missing", "case"], 7)];
  const d = diffClusters(prev, curr);
  assert.equal(d.strengthened.length, 1);
  assert.equal(d.added.length, 0);
});

test("renderDiff: produces sectioned markdown", () => {
  const diff = {
    added: [mk(["new"], 3)],
    strengthened: [{ current: mk(["test"], 6, 4), previous: mk(["test"], 3, 2), dOcc: 3, dAuth: 2 }],
    weakened: [],
    removed: [mk(["old"], 2)],
    unchanged: [],
  };
  const out = renderDiff(diff);
  assert.match(out, /## \+ New rules/);
  assert.match(out, /## ↑ Strengthened/);
  assert.match(out, /## − Gone/);
  assert.match(out, /\+3 occurrences, \+2 authors/);
});

test("renderDiff: empty diff renders 'No changes' message", () => {
  const out = renderDiff({ added: [], strengthened: [], weakened: [], removed: [], unchanged: [] });
  assert.match(out, /No changes/);
});

test("diffClusters: previous cluster cannot be matched by two current clusters (fission)", () => {
  // A previously-broad cluster fissions into two narrower clusters as the
  // corpus grows. Before the fix, BOTH current clusters Jaccard-overlap
  // ≥ 0.5 with the same previous, so both got matched and the previous
  // was never reported as removed. After: exactly one is matched (best
  // score), the other is `added`, and the previous-side total is honoured.
  const prev = [mk(["test", "missing", "case"], 8, 4)];
  // Current cluster A shares 2/3 tokens with previous (score 2/4 = 0.5).
  // Current cluster B shares 3/3 tokens with previous (score 3/3 = 1.0)
  // → B is the closer match and should win.
  const curr = [
    mk(["test", "missing", "edge"], 5, 3),
    mk(["test", "missing", "case"], 10, 5),
  ];
  const d = diffClusters(prev, curr);

  // Bijective invariant: every current cluster is in exactly one of
  // strengthened/weakened/unchanged/added.
  assert.equal(
    d.strengthened.length + d.weakened.length + d.unchanged.length + d.added.length,
    curr.length,
  );
  // The previous cluster was claimed by at most one current cluster.
  const matchedPrevCount = d.strengthened.length + d.weakened.length + d.unchanged.length;
  assert.equal(matchedPrevCount, 1);
  // The closer match (full token overlap) wins.
  assert.deepEqual(d.strengthened[0].current.label, ["test", "missing", "case"]);
  // The other current cluster is reported as added, not as a second match.
  assert.equal(d.added.length, 1);
  assert.deepEqual(d.added[0].label, ["test", "missing", "edge"]);
});

test("diffClusters: current cluster cannot be matched by two previous clusters", () => {
  // Symmetric case: two previous clusters both Jaccard-overlap with one
  // current cluster. Only the closer one matches; the other is `removed`.
  const prev = [
    mk(["test", "missing", "edge"], 4, 2),
    mk(["test", "missing", "case"], 7, 3),
  ];
  const curr = [mk(["test", "missing", "case"], 9, 4)];
  const d = diffClusters(prev, curr);

  assert.equal(d.strengthened.length, 1);
  assert.deepEqual(d.strengthened[0].previous.label, ["test", "missing", "case"]);
  assert.equal(d.removed.length, 1);
  assert.deepEqual(d.removed[0].label, ["test", "missing", "edge"]);
});

test("writeCurrentState: unchanged clusters leave the state file (and written_at) alone", async () => {
  const { mkdtempSync, readFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { writeCurrentState } = await import("../lib/diff.mjs");
  const dir = mkdtempSync(join(tmpdir(), "state-"));
  try {
    const kept = [{ label: ["any", "type"], occurrences: 3, distinctAuthors: 2, distinctPRs: 3 }];
    const path = writeCurrentState(dir, kept);
    const before = readFileSync(path, "utf-8");
    await new Promise((r) => setTimeout(r, 5));
    writeCurrentState(dir, kept);
    assert.equal(readFileSync(path, "utf-8"), before);
    writeCurrentState(dir, [{ ...kept[0], occurrences: 4 }]);
    assert.notEqual(readFileSync(path, "utf-8"), before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
