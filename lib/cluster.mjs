// Cluster candidate rules by topic similarity, using a pluggable
// similarity engine (see lib/similarity.mjs).
//
// Greedy clustering compares each new item against each existing
// cluster's centroid (engine-defined) and assigns to the highest-scoring
// cluster ≥ threshold. Otherwise starts a new cluster.
//
// Two reasons centroid-not-union:
//   - The union grows monotonically as items are added, so early clusters
//     become magnets that absorb unrelated items ("topic drift").
//   - With TF-IDF or embedding engines, a compact mean vector is the
//     standard centroid representation. Union doesn't generalize.
//
// Determinism: candidates are sorted before clustering so identical
// input produces identical output regardless of JSON ordering. All
// tiebreak comparisons use a plain binary (codepoint) compare rather
// than String.prototype.localeCompare, because localeCompare depends
// on the host's ICU collation and LANG/LC_COLLATE — so two machines
// (e.g., macOS dev vs Linux CI vs Alpine) would otherwise produce
// different cluster orderings and different generated rules for the
// same input JSON.

import { engineByName } from "./similarity.mjs";

const CENTROID_SIZE = 6;

// Locale-independent string compare. Do NOT replace with localeCompare:
// that breaks cross-environment reproducibility (see block comment above).
function binCmp(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function recomputeTokenCentroid(cluster) {
  // Maintained for label generation (labelCluster reads centroidTokens).
  // Also used by the jaccard engine as the cluster-similarity target.
  const freq = new Map();
  for (const item of cluster.items) {
    for (const t of new Set(item.tokens)) {
      freq.set(t, (freq.get(t) ?? 0) + 1);
    }
  }
  const top = [...freq.entries()]
    .sort((a, b) => b[1] - a[1] || binCmp(a[0], b[0]))
    .slice(0, CENTROID_SIZE)
    .map(([t]) => t);
  cluster.centroidTokens = new Set(top);
  cluster.unionTokens = new Set([...cluster.unionTokens, ...top]);
}

function sortKey(item) {
  return `${[...item.tokens].sort().join(" ")}|${item.sentence}|${item.pr ?? ""}`;
}

// "Don't add tests here" and "please add tests" share every topic token
// but say opposite things. Clusters never mix the two polarities.
// Removal advice ("no need to …", "can be removed") and necessity questions
// ("is this necessary?") are negative too, whatever their kind.
const NEGATIVE_TRIGGER_RE =
  /^(?:no need to|not needed|isn'?t (?:needed|necessary)|(?:is|are) (?:redundant|unnecessary)|can be (?:removed|omitted|dropped|deleted)|is (?:this|that|it)|do we|not sure)/;
export const polarity = (item) =>
  item.kind === "prohibition" || NEGATIVE_TRIGGER_RE.test(item.trigger ?? "") ? "negative" : "positive";

export function clusterCandidates(candidates, opts = {}) {
  const { threshold = 0.34, engine: engineName = "jaccard" } = opts;
  const items = candidates
    .map((c) => ({ ...c, tokenSet: new Set(c.tokens) }))
    .sort((a, b) => binCmp(sortKey(a), sortKey(b)));

  const engine = engineByName(engineName).build(items);
  const clusters = [];
  for (const item of items) {
    let best = null;
    let bestScore = 0;
    for (const cluster of clusters) {
      if (cluster.polarity !== polarity(item)) continue;
      const score = engine.similarityToCluster(item, cluster);
      if (score > bestScore) {
        best = cluster;
        bestScore = score;
      }
    }
    if (best && bestScore >= threshold) {
      best.items.push(item);
      for (const t of item.tokenSet) best.unionTokens.add(t);
      recomputeTokenCentroid(best);
      engine.onClusterMembershipChange?.(best);
    } else {
      const cluster = {
        polarity: polarity(item),
        items: [item],
        unionTokens: new Set(item.tokenSet),
        centroidTokens: new Set(item.tokenSet),
      };
      clusters.push(cluster);
      engine.onClusterMembershipChange?.(cluster);
    }
  }
  return clusters;
}

// Pick the most representative tokens to label a cluster (top-N by frequency
// across items, excluding tokens that appear in only one item if cluster > 2).
export function labelCluster(cluster, { topN = 4 } = {}) {
  const freq = new Map();
  for (const item of cluster.items) {
    for (const t of new Set(item.tokens)) {
      freq.set(t, (freq.get(t) ?? 0) + 1);
    }
  }
  const minCount = cluster.items.length > 2 ? 2 : 1;
  const ranked = [...freq.entries()]
    .filter(([, n]) => n >= minCount)
    .sort((a, b) => b[1] - a[1] || binCmp(a[0], b[0]))
    .slice(0, topN)
    .map(([t]) => t);
  return ranked;
}
