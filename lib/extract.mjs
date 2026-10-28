// Top-level extraction: PR comment JSON → candidate rules → clusters → scored.

import { stripMarkdown, splitSentences, isNoise } from "./normalize.mjs";
import { classifySentence, tokenize } from "./patterns.mjs";
import { clusterCandidates, labelCluster } from "./cluster.mjs";
import { applySignals } from "./signals.mjs";

function iterAllComments(data) {
  return [
    ...(data.issue_comments ?? []),
    ...(data.review_comments ?? []),
    ...(data.review_submissions ?? []),
  ];
}

// Blank out `inline code` with same-length filler so pattern matching
// ignores code (`use()` isn't a "use X" prescription) while character
// offsets still line up with the original sentence.
function maskInlineCode(sentence) {
  return sentence.replace(/`[^`\n]+`/g, (m) => `\`${"_".repeat(m.length - 2)}\``);
}

export function extractCandidates(data, opts = {}) {
  const enriched = opts.skipSignals ? data : applySignals(data, opts.signals);
  const candidates = [];
  for (const c of iterAllComments(enriched)) {
    if (isNoise(c)) continue;
    const cleaned = stripMarkdown(c.body, { keepInlineCode: true });
    for (const sentence of splitSentences(cleaned)) {
      const classified = classifySentence(maskInlineCode(sentence));
      if (!classified) continue;
      const remainder = sentence.slice(classified.remainderStart).replace(/[.?!]+$/, "").trim();
      // Prefer tokens from the remainder (the part after "don't" / "use"),
      // but fall back to the whole sentence when that yields more: "Is
      // this necessary?" has an empty remainder, and "Avoid any types"
      // keeps only "types" once stopwords go.
      let tokens = tokenize(remainder);
      if (tokens.length < 2) {
        const sentenceTokens = tokenize(sentence);
        if (sentenceTokens.length > tokens.length) tokens = sentenceTokens;
      }
      if (tokens.length < 1) continue;
      candidates.push({
        kind: classified.kind,
        trigger: classified.trigger,
        remainder,
        sentence,
        tokens,
        author: c.author,
        pr: c.pr_number,
        path: c.path ?? null,
        url: c.html_url,
        type: c.type,
        weight: c.weight ?? 1.0,
        createdAt: c.created_at ?? c.submitted_at ?? null,
      });
    }
  }
  return candidates;
}

// The kind most items in the cluster share. Ties go to the stronger kind,
// so one stray "don't" can't relabel a cluster of "please add a test"s as
// "Avoid: …" (which is what happened when any prohibition won outright).
const KIND_PRIORITY = ["prohibition", "prescription", "request", "question"];
function dominantKind(items) {
  const counts = new Map();
  for (const i of items) counts.set(i.kind, (counts.get(i.kind) ?? 0) + 1);
  return [...counts.entries()].sort(
    (a, b) => b[1] - a[1] || KIND_PRIORITY.indexOf(a[0]) - KIND_PRIORITY.indexOf(b[0]),
  )[0]?.[0] ?? "question";
}

export function buildClusters(candidates, opts = {}) {
  const clusters = clusterCandidates(candidates, opts);
  return clusters.map((cluster) => {
    const authors = new Set(cluster.items.map((i) => i.author));
    const prs = new Set(cluster.items.map((i) => i.pr).filter((x) => x != null));
    const paths = new Set(cluster.items.map((i) => i.path).filter(Boolean));
    const kinds = new Set(cluster.items.map((i) => i.kind));
    // Count unique (author, pr) tuples — so one verbose comment with three
    // imperative sentences from the same reviewer on the same PR counts once.
    // Without this, a single chatty review can dominate a cluster's "occurrences".
    const authorPrTuples = new Set(
      cluster.items.map((i) => `${i.author}::${i.pr ?? ""}`),
    );
    // Weighted occurrences: sum the per-tuple max weight so that a comment
    // landing in a CHANGES_REQUESTED review (weight 2.0) counts twice as
    // strongly as an APPROVED-review nit (weight 0.5). Truncated at the
    // tuple level for the same anti-spam reason as raw occurrences.
    const tupleWeights = new Map();
    for (const item of cluster.items) {
      const key = `${item.author}::${item.pr ?? ""}`;
      const w = item.weight ?? 1.0;
      tupleWeights.set(key, Math.max(tupleWeights.get(key) ?? 0, w));
    }
    const weightedOccurrences =
      [...tupleWeights.values()].reduce((a, b) => a + b, 0);
    const dates = cluster.items
      .map((i) => i.createdAt)
      .filter(Boolean)
      .map((d) => new Date(d).getTime())
      .filter((t) => Number.isFinite(t));
    const firstSeen = dates.length ? new Date(Math.min(...dates)).toISOString() : null;
    const lastSeen = dates.length ? new Date(Math.max(...dates)).toISOString() : null;
    return {
      label: labelCluster(cluster),
      items: cluster.items,
      occurrences: authorPrTuples.size,
      weightedOccurrences,
      rawItems: cluster.items.length,
      distinctAuthors: authors.size,
      distinctPRs: prs.size,
      paths: [...paths],
      kinds: [...kinds],
      kind: dominantKind(cluster.items),
      authors: [...authors],
      firstSeen,
      lastSeen,
    };
  });
}

export function filterClusters(
  clusters,
  { minOccurrences = 3, minAuthors = 2, minWeighted = 0 } = {},
) {
  return clusters
    .filter(
      (c) =>
        c.occurrences >= minOccurrences &&
        c.distinctAuthors >= minAuthors &&
        c.weightedOccurrences >= minWeighted,
    )
    .sort(
      (a, b) =>
        b.weightedOccurrences - a.weightedOccurrences ||
        b.occurrences - a.occurrences ||
        b.distinctAuthors - a.distinctAuthors,
    );
}

// Pick up to n items to quote as evidence: one per source comment (a
// comment with two matching sentences shouldn't fill two slots), and
// distinct reviewers first so "3 reviewers said this" is visible in the
// quotes themselves.
export function pickExamples(items, n) {
  const seenComments = new Set();
  const unique = items.filter((i) => {
    const key = i.url ?? i.sentence;
    if (seenComments.has(key)) return false;
    seenComments.add(key);
    return true;
  });
  const seenAuthors = new Set();
  const firstPerAuthor = unique.filter((i) => {
    if (seenAuthors.has(i.author)) return false;
    seenAuthors.add(i.author);
    return true;
  });
  const rest = unique.filter((i) => !firstPerAuthor.includes(i));
  return [...firstPerAuthor, ...rest].slice(0, n);
}
