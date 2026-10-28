// Portable corpus file: a copy of the fetched PR-comment JSON committed
// (or gitignored) inside the target repo so every downstream user can run
// the toolkit with zero GitHub token and zero network.
//
// Workflow:
//   1. One person (or a CI bot) runs `reviewlore fetch --cache` once with
//      a token. The corpus is cached in ~/.reviewlore/.
//   2. That person runs `reviewlore publish-corpus` which copies
//      the cache into <target>/.reviewlore-corpus.json.
//   3. They commit the corpus file (or gitignore it — their choice).
//   4. Every other developer's `reviewlore run` auto-detects the
//      corpus and uses it instead of calling GitHub. No token needed.
//
// File location: <target>/.reviewlore-corpus.json
//   Dotfile-style so it's a clear "tool artefact" rather than user content.
//   Sits at the repo root so it's both discoverable (committable) and
//   easy to gitignore (`.reviewlore-*`).
//
// The corpus is the cache slimmed to what can affect output (lib/slim.mjs),
// one record per line: about a tenth of the size on busy repos, and
// refreshes diff record by record.
//
// Data sensitivity: the corpus contains reviewer logins, PR-comment bodies
// verbatim, and URLs. For PUBLIC repos this is all already public data.
// For PRIVATE repos: committing the corpus exposes the same PR comments
// to anyone with repo read access — which is precisely the set of people
// who could read them on GitHub anyway. No new exposure, but worth noting.

import { existsSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadCache, cachePath } from "./cache.mjs";
import { redactCorpus, scanCorpus } from "./secret-scan.mjs";
import { slimCorpus, serializeCorpus } from "./slim.mjs";

export const CORPUS_FILENAME = ".reviewlore-corpus.json";

export function corpusPath(targetDir) {
  return join(resolve(targetDir), CORPUS_FILENAME);
}

// Load the corpus if present. Returns null if the file doesn't exist or
// is unparseable (treat as "no corpus available; fall back to API").
export function loadCorpus(targetDir) {
  const path = corpusPath(targetDir);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
}

// Returns an info object about a corpus file (path, ageDays, sizeKb,
// meta) — used by `publish-corpus` to tell the user what they're doing,
// and by `run` to print a "using corpus from X days ago" hint.
export function corpusInfo(targetDir) {
  const path = corpusPath(targetDir);
  if (!existsSync(path)) return null;
  let parsed = null;
  try {
    parsed = JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return { path, error: "corrupt" };
  }
  const stats = statSync(path);
  const ageDays = (Date.now() - stats.mtimeMs) / (1000 * 60 * 60 * 24);
  return {
    path,
    sizeKb: Math.round(stats.size / 1024),
    ageDays,
    meta: parsed.meta ?? {},
    totals: parsed.meta?.totals ?? {},
  };
}

// Publish the cache for (owner, repo) into the target repo's corpus
// file. Returns { path, sizeKb, totals, warnings } on success, throws
// on failure.
//
// PR comment bodies come verbatim from the GitHub API — including any
// credential a reviewer ever pasted (PATs, AWS keys, sk-ant- keys,
// PEM blocks). Once the corpus is committed those credentials end up
// in `git log` forever. We scan every body before writing:
//
//   onSecrets: "redact"  (default) — substitute [REDACTED] for matches
//                                    and report the affected PR URLs.
//   onSecrets: "refuse"            — throw with the offending PR URLs;
//                                    nothing is written.
export function publishCorpus({ owner, repo, host = "github.com", targetDir, onSecrets = "redact" }) {
  const full = loadCache(owner, repo, host);
  if (!full) {
    throw new Error(
      `No cache for ${owner}/${repo}. Run \`reviewlore fetch --owner ${owner} --repo ${repo} --cache\` first.`,
    );
  }
  // Slim first: fewer bodies to scan, and nothing unscanned is published.
  const cached = slimCorpus(full);

  let warnings = [];
  if (onSecrets === "refuse") {
    warnings = scanCorpus(cached);
    if (warnings.length > 0) {
      const lines = warnings.slice(0, 10).map(
        (w) => `  - ${w.html_url ?? "(unknown URL)"} [${w.labels.join(", ")}]`,
      );
      const extra = warnings.length > 10 ? `\n  ... and ${warnings.length - 10} more` : "";
      throw new Error(
        `Refusing to publish corpus: ${warnings.length} comment(s) contain credential-shaped strings.\n` +
        `${lines.join("\n")}${extra}\n` +
        `Edit or delete the offending comments on GitHub, refresh the cache, then re-run.`,
      );
    }
  } else {
    // Default: redact in place and report so the caller can warn the user.
    warnings = redactCorpus(cached);
  }

  const path = corpusPath(targetDir);
  const json = serializeCorpus(cached);
  // Same comments as the committed file → don't rewrite it just to bump
  // fetch timestamps (a scheduled refresh would otherwise open a PR every
  // run with no real change).
  const unchanged = sameCorpusContent(loadCorpus(targetDir), cached);
  if (!unchanged) writeFileSync(path, json, "utf-8");
  return {
    path,
    sizeKb: Math.round(Buffer.byteLength(json, "utf-8") / 1024),
    sourceSizeKb: Math.round(statSync(cachePath(owner, repo, host)).size / 1024),
    totals: cached.meta?.totals ?? {},
    dropped: cached.meta.slim.dropped,
    warnings,
    unchanged,
  };
}

// Compared in serialised form, so an older (pretty-printed, unslimmed)
// committed corpus counts as changed and gets rewritten.
function sameCorpusContent(a, b) {
  if (!a || !b) return false;
  const strip = ({ meta = {}, ...rest }) => {
    const { fetched_at, last_fetched_at, ...stableMeta } = meta;
    return { meta: stableMeta, ...rest };
  };
  return serializeCorpus(strip(a)) === serializeCorpus(strip(b)) && a.meta?.schema_version === b.meta?.schema_version;
}
