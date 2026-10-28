// Shared rule normalization. Takes a raw cluster (and optionally an LLM
// synth result) and produces a `Rule` — the canonical shape every renderer
// reads from.
//
// The intent is that adding a new renderer (Aider, Windsurf, JetBrains,
// future-tool-of-the-month) only requires implementing
// "given a Rule, serialise to your format" — not re-deriving titles,
// reps, severities, glob patterns from raw cluster items each time.
//
// Schema (informal — see types in jsdoc on normalizeRule):
//   Rule {
//     id, title, body, why, when_to_apply, kind, severity,
//     globs[], occurrences, weighted_occurrences, distinct_authors,
//     distinct_prs, first_seen, last_seen, authors[], paths[],
//     examples[{quote, author, pr, url, path}],
//     source: "heuristic" | "llm-synthesised",
//   }

import { extname } from "node:path";
import { pickExamples } from "../extract.mjs";

const KIND_VERBS = { prohibition: "avoid", prescription: "follow", request: "address" };

function pickRepSentence(items) {
  return [...items]
    .filter((i) => i.sentence.length >= 25 && i.sentence.length <= 200)
    .sort((a, b) => a.sentence.length - b.sentence.length)[0]?.sentence
    ?? items[0]?.sentence ?? "";
}

function inferKind(cluster) {
  if (cluster.kind) return cluster.kind;
  const kinds = cluster.kinds ?? [];
  if (kinds.includes("prohibition")) return "prohibition";
  if (kinds.includes("prescription")) return "prescription";
  if (kinds.includes("request")) return "request";
  return "question";
}

function inferSeverity(cluster) {
  // Heuristic: blocking review-state weight × occurrence count → "must" / "should" / "consider"
  const w = cluster.weightedOccurrences ?? cluster.occurrences ?? 0;
  if (w >= 10) return "must";
  if (w >= 5) return "should";
  return "consider";
}

function uniqueExtensions(paths) {
  const exts = new Set();
  for (const p of paths) {
    const e = extname(p).toLowerCase();
    if (e) exts.add(e);
  }
  return [...exts].sort();
}

// Directories whose children are separate packages: scope to the package
// (packages/<name>/**) rather than the whole of packages/.
const PACKAGE_DIRS = new Set(["packages", "apps", "libs", "services", "modules", "crates", "plugins"]);

// Globs that scope a rule to the code its comments were about: the
// top-level directory (or package) plus the file extension, e.g.
// "packages/vitest/**/*.ts". Root files are matched by name. When the
// comments span more than `max` places, fall back to extension-only
// globs ("**/*.ts") rather than emitting a long, brittle list.
export function pathGlobs(paths, { max = 5 } = {}) {
  const globs = new Set();
  for (const p of paths) {
    const dirs = p.replace(/^\.\//, "").split("/");
    const file = dirs.pop();
    if (dirs.length === 0) {
      globs.add(file);
      continue;
    }
    const depth = PACKAGE_DIRS.has(dirs[0]) && dirs.length >= 2 ? 2 : 1;
    const ext = extname(file);
    globs.add(`${dirs.slice(0, depth).join("/")}/**${ext ? `/*${ext}` : ""}`);
  }
  if (globs.size <= max) return [...globs].sort();
  return uniqueExtensions(paths).map((e) => `**/*${e}`);
}

function defaultWhen(cluster) {
  const exts = uniqueExtensions(cluster.paths ?? []);
  return exts.length
    ? `When editing files matching: ${exts.join(", ")}.`
    : "When editing any file in this repository.";
}

function slugifyTitle(title) {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60) || "rule";
}

// Stable ID per cluster: derived from sorted top tokens. Survives between
// runs as long as the cluster's vocabulary stays roughly the same — useful
// for tools that want to dedupe / track rules over time.
function clusterId(cluster) {
  const tokens = (cluster.label ?? []).map((t) => String(t).toLowerCase()).sort().join("-");
  return slugifyTitle(tokens);
}

export function normalizeRule(cluster, synth = null) {
  const useSynth = synth && !synth._error && synth.name !== "INCOHERENT";
  const kind = useSynth ? (synth.kind ?? inferKind(cluster)) : inferKind(cluster);
  const verb = KIND_VERBS[kind] ?? "consider";
  const repSentence = pickRepSentence(cluster.items ?? []);

  // One reviewer (single-maintainer mode): labelled as a preference.
  const prefix = cluster.distinctAuthors === 1 ? "Maintainer preference: " : "";
  const title = prefix + (useSynth
    ? synth.name.replace(/[.!?]+$/, "").trim()
    : `${verb[0].toUpperCase()}${verb.slice(1)}: ${(cluster.label ?? []).join(" / ") || "review pattern"}`);

  const body = useSynth ? synth.rule : repSentence;
  const why = useSynth
    ? synth.why
    : `Recurred ${cluster.occurrences ?? 0}× across ${cluster.distinctAuthors ?? 0} reviewers on ${cluster.distinctPRs ?? 0} PRs.`;
  const when_to_apply = useSynth ? synth.when_to_apply : defaultWhen(cluster);

  return {
    id: clusterId(cluster),
    title,
    body,
    why,
    when_to_apply,
    kind,
    severity: inferSeverity(cluster),
    globs: pathGlobs(cluster.paths ?? []),
    occurrences: cluster.occurrences ?? 0,
    weighted_occurrences: cluster.weightedOccurrences ?? cluster.occurrences ?? 0,
    distinct_authors: cluster.distinctAuthors ?? 0,
    distinct_prs: cluster.distinctPRs ?? 0,
    first_seen: cluster.firstSeen ?? null,
    last_seen: cluster.lastSeen ?? null,
    authors: cluster.authors ?? [],
    paths: cluster.paths ?? [],
    examples: pickExamples(cluster.items ?? [], 5).map((it) => ({
      quote: it.sentence,
      author: it.author,
      pr: it.pr,
      url: it.url,
      path: it.path,
    })),
    source: useSynth ? "llm-synthesised" : "heuristic",
    synth_error: synth?._error ?? null,
  };
}

export function normalizeAll(clusters, synth = null) {
  return clusters.map((c, i) => normalizeRule(c, synth?.[i]));
}

// "N days ago" helper for human-readable timestamps. Returns undefined if
// the input is missing.
export function relativeAge(iso, now = new Date()) {
  if (!iso) return undefined;
  const ms = now.getTime() - new Date(iso).getTime();
  if (ms < 0) return "in the future";
  const days = Math.floor(ms / (1000 * 60 * 60 * 24));
  if (days < 1) return "today";
  if (days < 2) return "yesterday";
  if (days < 30) return `${days} days ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months} month${months === 1 ? "" : "s"} ago`;
  const years = Math.floor(months / 12);
  return `${years} year${years === 1 ? "" : "s"} ago`;
}
