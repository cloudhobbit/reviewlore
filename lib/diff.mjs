// Cluster-set diff: compare a previous run's clusters against the current
// run's clusters. Surfaces four categories of change:
//
//   + NEW       — cluster present now, absent before
//   ↑ STRONGER  — same cluster (matched by label intersection), now with
//                 more occurrences / more authors
//   ↓ WEAKER    — same cluster, now with fewer occurrences / authors
//   − GONE      — cluster present before, absent now
//
// Cluster identity across runs is fuzzy: token labels shift slightly as
// the corpus grows. We match on Jaccard overlap of label-token sets
// (≥ MATCH_THRESHOLD) — same heuristic used for incremental
// reproducibility, not strict identity.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const MATCH_THRESHOLD = 0.5;

// State file written under <target>/.claude/ so re-runs can compute a
// diff against the previous run. Kept tiny on purpose: label + counts.
export const STATE_FILENAME = ".reviewlore-state.json";

export function statePath(targetDir) {
  return join(targetDir, ".claude", STATE_FILENAME);
}

export function loadPreviousState(targetDir) {
  const path = statePath(targetDir);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    // Corrupted state file is non-fatal; treat as no previous run.
    return null;
  }
}

export function writeCurrentState(targetDir, kept) {
  const path = statePath(targetDir);
  const clusters = kept.map((c) => ({
    label: c.label,
    occurrences: c.occurrences,
    distinctAuthors: c.distinctAuthors,
    distinctPRs: c.distinctPRs,
  }));
  // Unchanged clusters → leave the file (and its written_at) alone, so a
  // scheduled run with nothing new produces no diff and no PR.
  const previous = loadPreviousState(targetDir);
  if (previous && JSON.stringify(previous.clusters) === JSON.stringify(clusters)) return path;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ written_at: new Date().toISOString(), clusters }, null, 2), "utf-8");
  return path;
}

// Returns a string to print to stderr describing the diff, or null if
// there is no previous state to compare against.
export function reportDiffSinceLastRun(previousState, kept) {
  if (!previousState?.clusters) return null;
  const diff = diffClusters(previousState.clusters, kept);
  const totalChanges =
    diff.added.length + diff.strengthened.length +
    diff.weakened.length + diff.removed.length;
  if (totalChanges > 0) return renderDiff(diff);
  return "(No cluster changes since previous run.)\n";
}

function jaccard(a, b) {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

function labelSet(cluster) {
  return new Set((cluster.label ?? []).map((t) => String(t).toLowerCase()));
}

// Bijective greedy assignment: enumerate every (current, previous) pair
// whose Jaccard ≥ MATCH_THRESHOLD, sort by score descending (with stable
// tiebreakers on index so output is deterministic across runs), then
// assign greedily so each cluster on either side participates in at most
// one match. Anything left unmatched falls into added / removed.
//
// This is intentionally simpler than the Hungarian algorithm: we don't
// need optimal global matching, just a fix for the "two current clusters
// claim the same previous" bug. Greedy on a sorted score list is
// sufficient and O(n·m·log(n·m)) which is fine for cluster counts in the
// dozens.
export function diffClusters(previous, current) {
  const prev = previous ?? [];
  const curr = current ?? [];
  const result = { added: [], strengthened: [], weakened: [], removed: [], unchanged: [] };

  const prevSets = prev.map(labelSet);
  const currSets = curr.map(labelSet);

  const candidates = [];
  for (let i = 0; i < curr.length; i++) {
    for (let j = 0; j < prev.length; j++) {
      const score = jaccard(currSets[i], prevSets[j]);
      if (score >= MATCH_THRESHOLD) candidates.push({ i, j, score });
    }
  }
  candidates.sort((a, b) => b.score - a.score || a.i - b.i || a.j - b.j);

  const currMatched = new Set();
  const prevMatched = new Set();
  const pairs = []; // ordered by current index for stable output
  for (const { i, j } of candidates) {
    if (currMatched.has(i) || prevMatched.has(j)) continue;
    currMatched.add(i);
    prevMatched.add(j);
    pairs.push({ i, j });
  }
  pairs.sort((a, b) => a.i - b.i);

  for (const { i, j } of pairs) {
    const c = curr[i];
    const m = prev[j];
    const dOcc = (c.occurrences ?? 0) - (m.occurrences ?? 0);
    const dAuth = (c.distinctAuthors ?? 0) - (m.distinctAuthors ?? 0);
    if (dOcc > 0 || dAuth > 0) {
      result.strengthened.push({ current: c, previous: m, dOcc, dAuth });
    } else if (dOcc < 0 || dAuth < 0) {
      result.weakened.push({ current: c, previous: m, dOcc, dAuth });
    } else {
      result.unchanged.push({ current: c, previous: m });
    }
  }
  for (let i = 0; i < curr.length; i++) {
    if (!currMatched.has(i)) result.added.push(curr[i]);
  }
  for (let j = 0; j < prev.length; j++) {
    if (!prevMatched.has(j)) result.removed.push(prev[j]);
  }
  return result;
}

export function renderDiff(diff) {
  const lines = [`# Cluster diff vs previous run`, ``];
  if (diff.added.length === 0 && diff.strengthened.length === 0 &&
      diff.weakened.length === 0 && diff.removed.length === 0) {
    lines.push("_No changes since last run._");
    return lines.join("\n") + "\n";
  }
  if (diff.added.length) {
    lines.push("## + New rules");
    for (const c of diff.added) {
      lines.push(`- **${(c.label ?? []).join(" / ")}** — ${c.occurrences}× / ${c.distinctAuthors} authors`);
    }
    lines.push("");
  }
  if (diff.strengthened.length) {
    lines.push("## ↑ Strengthened");
    for (const { current, previous, dOcc, dAuth } of diff.strengthened) {
      lines.push(
        `- **${(current.label ?? []).join(" / ")}** — ${current.occurrences}× / ${current.distinctAuthors} authors (was ${previous.occurrences}× / ${previous.distinctAuthors}, +${dOcc} occurrences, +${dAuth} authors)`,
      );
    }
    lines.push("");
  }
  if (diff.weakened.length) {
    lines.push("## ↓ Weakened");
    for (const { current, previous, dOcc, dAuth } of diff.weakened) {
      lines.push(
        `- **${(current.label ?? []).join(" / ")}** — ${current.occurrences}× / ${current.distinctAuthors} authors (was ${previous.occurrences}× / ${previous.distinctAuthors}, ${dOcc} occurrences, ${dAuth} authors)`,
      );
    }
    lines.push("");
  }
  if (diff.removed.length) {
    lines.push("## − Gone");
    for (const c of diff.removed) {
      lines.push(`- **${(c.label ?? []).join(" / ")}** — was ${c.occurrences}× / ${c.distinctAuthors} authors`);
    }
    lines.push("");
  }
  return lines.join("\n") + "\n";
}
