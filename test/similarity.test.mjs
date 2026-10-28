import { test } from "node:test";
import assert from "node:assert/strict";
import { jaccardEngine, semanticEngine, engineByName } from "../lib/similarity.mjs";

const mk = (tokens) => ({ tokens, tokenSet: new Set(tokens) });

test("engineByName: jaccard and semantic resolve", () => {
  assert.equal(engineByName("jaccard").name, "jaccard");
  assert.equal(engineByName("semantic").name, "semantic");
  assert.throws(() => engineByName("bogus"));
});

test("jaccard engine: identical sets score 1; disjoint sets score 0", () => {
  const e = jaccardEngine().build([]);
  const a = mk(["x", "y", "z"]);
  const b = mk(["x", "y", "z"]);
  const c = mk(["q", "r"]);
  assert.equal(e.similarity(a, b), 1);
  assert.equal(e.similarity(a, c), 0);
});

test("semantic engine: rare-token overlap scores higher than common-token overlap", () => {
  // Common tokens (in many items) get low IDF; rare tokens get high IDF.
  // Two items sharing a RARE token should score higher than two sharing
  // only a COMMON token.
  const corpus = [
    mk(["common", "alpha"]),
    mk(["common", "beta"]),
    mk(["common", "gamma"]),
    mk(["common", "delta"]),
    mk(["common", "epsilon"]),
    mk(["rare-x", "alpha"]), // rare-x appears once
    mk(["rare-x", "beta"]),  // rare-x appears twice (still rare)
  ];
  const e = semanticEngine().build(corpus);
  const sharingRare = e.similarity(
    mk(["rare-x", "unique-a"]),
    mk(["rare-x", "unique-b"]),
  );
  const sharingCommon = e.similarity(
    mk(["common", "unique-a"]),
    mk(["common", "unique-b"]),
  );
  assert.ok(
    sharingRare > sharingCommon,
    `rare-token similarity (${sharingRare.toFixed(3)}) should exceed common-token (${sharingCommon.toFixed(3)})`,
  );
});

test("semantic engine: cluster centroid updates as members are added", () => {
  const corpus = [mk(["a", "b"]), mk(["a", "c"]), mk(["d", "e"])];
  const e = semanticEngine().build(corpus);
  const cluster = { items: [corpus[0]] };
  e.onClusterMembershipChange(cluster);
  const sim1 = e.similarityToCluster(corpus[1], cluster);

  cluster.items.push(corpus[1]);
  e.onClusterMembershipChange(cluster);
  const sim2 = e.similarityToCluster(corpus[1], cluster);

  // After joining the cluster, item should match its own centroid more strongly.
  assert.ok(sim2 >= sim1);
});
