// Pluggable similarity functions for clustering.
//
// Each engine returns a `similarity(itemA, itemB) → [0,1]` function.
// `build(items)` lets the engine precompute corpus statistics (TF-IDF
// needs DF; future embedding engines need the embedding matrix).
//
// Engines:
//   - "jaccard":  bag-of-words Jaccard over token sets. Zero corpus
//                 prep. Misses synonyms entirely.
//   - "semantic": TF-IDF cosine. Weights rare tokens higher (rare =
//                 informative), common tokens lower. Catches near-duplicates
//                 with different word choice; still bag-of-words so true
//                 synonyms remain split.
//
// Real embeddings (transformer or API) are a future engine that fits
// the same shape — return a similarity fn closed over a precomputed
// embedding matrix.

function jaccardSets(a, b) {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

export function jaccardEngine() {
  return {
    name: "jaccard",
    build(_items) {
      return {
        similarity: (a, b) => jaccardSets(a.tokenSet, b.tokenSet),
        signatureOf: (item) => item.tokenSet,
        // For comparing an item against a CLUSTER (centroid), the cluster
        // exposes `centroidTokens` (a Set). Both branches use jaccardSets.
        similarityToCluster: (item, cluster) =>
          jaccardSets(item.tokenSet, cluster.centroidTokens),
      };
    },
  };
}

export function semanticEngine() {
  return {
    name: "semantic",
    build(items) {
      // Document frequency: in how many items does each token appear?
      const df = new Map();
      for (const it of items) {
        const seen = new Set(it.tokens);
        for (const t of seen) df.set(t, (df.get(t) ?? 0) + 1);
      }
      const N = Math.max(items.length, 1);
      // IDF with smoothing — log((N+1) / (df+1)) + 1, similar to
      // sklearn's TfidfVectorizer(smooth_idf=True).
      const idf = (t) => Math.log((N + 1) / ((df.get(t) ?? 0) + 1)) + 1;

      const vectorOf = (item) => {
        const tf = new Map();
        for (const t of item.tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
        const v = new Map();
        let norm = 0;
        for (const [t, c] of tf.entries()) {
          const w = c * idf(t);
          v.set(t, w);
          norm += w * w;
        }
        norm = Math.sqrt(norm) || 1;
        for (const [t, w] of v.entries()) v.set(t, w / norm);
        return v;
      };

      // Precompute item vectors once.
      const cache = new Map();
      const vec = (item) => {
        if (!cache.has(item)) cache.set(item, vectorOf(item));
        return cache.get(item);
      };
      const cosine = (a, b) => {
        const [small, big] = a.size <= b.size ? [a, b] : [b, a];
        let dot = 0;
        for (const [t, w] of small.entries()) {
          const other = big.get(t);
          if (other !== undefined) dot += w * other;
        }
        return dot; // both already L2-normalized
      };

      return {
        similarity: (a, b) => cosine(vec(a), vec(b)),
        signatureOf: vec,
        // Cluster similarity uses the cluster's centroid vector, recomputed
        // when membership changes (mean of member vectors, then L2-normalized).
        similarityToCluster: (item, cluster) => {
          if (!cluster._tfidfCentroid) {
            cluster._tfidfCentroid = computeCentroidVector(cluster.items.map(vec));
          }
          return cosine(vec(item), cluster._tfidfCentroid);
        },
        onClusterMembershipChange(cluster) {
          cluster._tfidfCentroid = computeCentroidVector(cluster.items.map(vec));
        },
      };
    },
  };
}

function computeCentroidVector(vectors) {
  const sum = new Map();
  for (const v of vectors) {
    for (const [t, w] of v.entries()) sum.set(t, (sum.get(t) ?? 0) + w);
  }
  const n = Math.max(vectors.length, 1);
  let norm = 0;
  for (const [t, s] of sum.entries()) {
    const m = s / n;
    sum.set(t, m);
    norm += m * m;
  }
  norm = Math.sqrt(norm) || 1;
  for (const [t, m] of sum.entries()) sum.set(t, m / norm);
  return sum;
}

export function engineByName(name) {
  if (name === "jaccard") return jaccardEngine();
  if (name === "semantic") return semanticEngine();
  throw new Error(`Unknown similarity engine: ${name}`);
}
