// JSON renderer: writes the clusters as machine-readable JSON. Useful for
// downstream tooling (custom dashboards, alternative renderers, training
// data pipelines).
//
// Output path: <target>/reviewlore-rules.json
// (NOT inside .claude/ or .cursor/ since it's not an editor rule format.)

import { writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { pickExamples } from "../extract.mjs";

export const name = "json";
export const describe = "Machine-readable JSON: <target>/reviewlore-rules.json";

export function write(clusters, { targetDir, force = false, synth = null } = {}) {
  const path = join(targetDir, "reviewlore-rules.json");
  if (existsSync(path) && !force) {
    return { written: [], skipped: [{ path, slug: "json", occurrences: clusters.length }] };
  }
  const out = {
    generated_at: new Date().toISOString(),
    cluster_count: clusters.length,
    clusters: clusters.map((c, i) => ({
      label: c.label,
      occurrences: c.occurrences,
      weighted_occurrences: c.weightedOccurrences,
      distinct_authors: c.distinctAuthors,
      distinct_prs: c.distinctPRs,
      paths: c.paths,
      kinds: c.kinds,
      authors: c.authors,
      synthesised: synth?.[i] && !synth[i]._error ? synth[i] : null,
      examples: pickExamples(c.items, 5).map((it) => ({
        sentence: it.sentence,
        author: it.author,
        pr: it.pr,
        url: it.url,
        path: it.path,
      })),
    })),
  };
  writeFileSync(path, JSON.stringify(out, null, 2), "utf-8");
  return { written: [{ path, slug: "json", occurrences: clusters.length }], skipped: [] };
}
