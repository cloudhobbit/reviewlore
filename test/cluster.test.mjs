import { test } from "node:test";
import assert from "node:assert/strict";
import { clusterCandidates, labelCluster } from "../lib/cluster.mjs";

const mk = (tokens, overrides = {}) => ({ tokens, sentence: "s", author: "a", pr: 1, ...overrides });

test("similar token sets cluster together", () => {
  const cands = [
    mk(["test", "missing", "case"]),
    mk(["missing", "test", "edge"]),
    mk(["unrelated", "topic", "totally"]),
  ];
  const clusters = clusterCandidates(cands, { threshold: 0.3 });
  assert.equal(clusters.length, 2);
});

test("clusters respect threshold (high threshold → more clusters)", () => {
  const cands = [
    mk(["a", "b"]),
    mk(["a", "c"]),
    mk(["a", "d"]),
  ];
  const high = clusterCandidates(cands, { threshold: 0.9 });
  assert.equal(high.length, 3);
  const low = clusterCandidates(cands, { threshold: 0.2 });
  assert.equal(low.length, 1);
});

test("labelCluster picks top frequent tokens", () => {
  const cluster = {
    items: [
      mk(["test", "missing"]),
      mk(["test", "edge"]),
      mk(["test", "case"]),
    ],
  };
  const label = labelCluster(cluster, { topN: 2 });
  assert.ok(label.includes("test"));
});

test("prohibitions never cluster with prescriptions/requests on the same topic", () => {
  const cands = [
    mk(["add", "test", "case"], { kind: "request" }),
    mk(["add", "test", "case"], { kind: "prohibition" }),
    mk(["add", "test", "case"], { kind: "prescription" }),
  ];
  const clusters = clusterCandidates(cands, { threshold: 0.3 });
  assert.equal(clusters.length, 2);
  assert.ok(clusters.every((c) => new Set(c.items.map((i) => i.kind === "prohibition")).size === 1));
});

test("removal advice and necessity questions don't cluster with 'add X'", () => {
  const cands = [
    mk(["add", "changeset"], { kind: "request", trigger: "please" }),
    mk(["add", "changeset"], { kind: "request", trigger: "could you" }),
    mk(["add", "changeset"], { kind: "prescription", trigger: "no need to" }),
    mk(["add", "changeset"], { kind: "prescription", trigger: "can be removed" }),
    mk(["add", "changeset"], { kind: "question", trigger: "is this necessary" }),
  ];
  const sizes = clusterCandidates(cands, { threshold: 0.3 }).map((c) => c.items.length).sort();
  assert.deepEqual(sizes, [2, 3]);
});
