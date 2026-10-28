import { test } from "node:test";
import assert from "node:assert/strict";
import { clusterCandidates, labelCluster } from "../lib/cluster.mjs";

const mk = (tokens, extras = {}) => ({ tokens, sentence: tokens.join(" "), author: "a", pr: 1, ...extras });

test("clusterCandidates: output is independent of input order (Tier 2 #11)", () => {
  const items = [
    mk(["test", "missing", "case"]),
    mk(["test", "edge", "missing"]),
    mk(["unrelated", "topic"]),
    mk(["unrelated", "thing"]),
  ];
  const a = clusterCandidates([...items], { threshold: 0.3 });
  const b = clusterCandidates([...items].reverse(), { threshold: 0.3 });
  const signature = (clusters) =>
    clusters
      .map((c) => c.items.map((i) => i.tokens.join(",")).sort().join("|"))
      .sort()
      .join("\n");
  assert.equal(signature(a), signature(b), "reordering input must not change clusters");
});

test("clusterCandidates: centroid stays compact (Tier 2 #10)", () => {
  // Adding many slightly-related items should NOT cause one cluster's
  // centroid to grow unboundedly and absorb everything.
  const items = [
    mk(["test", "missing"]),
    mk(["test", "missing", "case"]),
    mk(["test", "missing", "edge"]),
    mk(["docs", "typo"]),
    mk(["docs", "wording"]),
    mk(["completely", "different", "topic"]),
  ];
  const clusters = clusterCandidates(items, { threshold: 0.3 });
  // We should end up with multiple clusters, not one giant magnet cluster.
  assert.ok(clusters.length >= 2, `expected multiple clusters, got ${clusters.length}`);
  // No cluster's centroid should grow past CENTROID_SIZE (=6) tokens.
  for (const c of clusters) {
    assert.ok(c.centroidTokens.size <= 6, `centroid size ${c.centroidTokens.size} exceeds cap`);
  }
});

test("cluster sort tiebreak uses binary (locale-independent) ordering", () => {
  // Regression: localeCompare returns ['a','B'] (case-insensitive, en_US-ish),
  // while a plain codepoint compare returns ['B','a'] (uppercase < lowercase
  // in ASCII). The cluster pipeline must use the codepoint order so that
  // identical input JSON produces identical output on macOS, Linux glibc,
  // Alpine (no ICU), and across LANG/LC_COLLATE settings — otherwise the
  // diff-mode 'added'/'removed' entries become noisy across environments.
  const cluster = {
    items: [
      { tokens: ["B", "a"] },
      { tokens: ["B", "a"] },
    ],
  };
  const ranked = labelCluster(cluster, { topN: 4 });
  assert.deepEqual(
    ranked,
    ["B", "a"],
    "expected binary codepoint order; got locale-dependent order — fix the localeCompare tiebreaks in lib/cluster.mjs",
  );

  // Same check applied to the centroid path (recomputeTokenCentroid):
  // run clusterCandidates with two identical items whose tokens are 'B'
  // and 'a', then inspect the resulting cluster's labels.
  const [c] = clusterCandidates(
    [
      mk(["B", "a"], { pr: 1 }),
      mk(["B", "a"], { pr: 2 }),
    ],
    { threshold: 0.3 },
  );
  assert.deepEqual(labelCluster(c, { topN: 4 }), ["B", "a"]);
});
