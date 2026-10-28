// Cursor renderer: writes one .mdc per cluster into
// <target>/.cursor/rules/pr-feedback-<slug>.mdc.
//
// Cursor's rule format uses .mdc files with a small YAML frontmatter
// (description + globs + alwaysApply). See:
//   https://docs.cursor.com/context/rules
//
// We map cluster paths' file extensions to a `globs` field so the rule
// auto-attaches when Cursor edits matching files. Clusters with no path
// info get alwaysApply: false (Cursor will use the description to match).

import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, extname } from "node:path";
import { pickExamples } from "../extract.mjs";

export const name = "cursor";
export const describe = "Cursor rules: <target>/.cursor/rules/pr-feedback-*.mdc";

function slugify(tokens) {
  return (tokens.join("-").replace(/[^a-z0-9-]/g, "").replace(/-+/g, "-").slice(0, 60)) || "rule";
}

function pickGlobs(cluster) {
  const exts = new Set();
  for (const p of cluster.paths ?? []) {
    const e = extname(p).toLowerCase();
    if (e) exts.add(e);
  }
  return [...exts].sort().map((e) => `**/*${e}`);
}

function quote(s) {
  return `"${String(s).replace(/\s+/g, " ").trim().replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function pickRepSentence(items) {
  return [...items]
    .filter((i) => i.sentence.length >= 25 && i.sentence.length <= 200)
    .sort((a, b) => a.sentence.length - b.sentence.length)[0]?.sentence
    ?? items[0]?.sentence ?? "";
}

function renderOne(cluster, synth) {
  const useSynth = synth && !synth._error && synth.name !== "INCOHERENT";
  const description = useSynth ? synth.rule : pickRepSentence(cluster.items);
  const slug = slugify(useSynth
    ? synth.name.toLowerCase().split(/\s+/).slice(0, 6)
    : cluster.label);
  const globs = pickGlobs(cluster);
  const examples = pickExamples(cluster.items, 3)
    .map((i) => `> ${i.sentence}\n— @${i.author} on PR #${i.pr ?? "?"}: ${i.url}`)
    .join("\n\n");

  const frontmatter = [
    "---",
    `description: ${quote(description)}`,
    globs.length ? `globs: [${globs.map(quote).join(", ")}]` : `alwaysApply: false`,
    "---",
    "",
  ].join("\n");

  const body =
    frontmatter +
    `# ${useSynth ? synth.name : (cluster.label.join(" / ") || "Review feedback")}\n\n` +
    (useSynth
      ? `${synth.rule}\n\n**Why:** ${synth.why}\n\n**When to apply:** ${synth.when_to_apply}\n`
      : `${description}\n\n**Why:** Recurred ${cluster.occurrences}× across ${cluster.distinctAuthors} reviewers on ${cluster.distinctPRs} PRs.\n`) +
    `\n## Source comments\n\n${examples}\n`;

  return { slug, body };
}

export function write(clusters, { targetDir, force = false, synth = null } = {}) {
  const dir = join(targetDir, ".cursor", "rules");
  mkdirSync(dir, { recursive: true });
  const written = [];
  const skipped = [];
  const seen = new Set();
  for (let i = 0; i < clusters.length; i++) {
    const cluster = clusters[i];
    const { slug, body } = renderOne(cluster, synth?.[i]);
    let final = slug;
    let n = 2;
    while (seen.has(final)) final = `${slug}-${n++}`;
    seen.add(final);
    const path = join(dir, `pr-feedback-${final}.mdc`);
    if (existsSync(path) && !force) {
      skipped.push({ path, slug: final, occurrences: cluster.occurrences });
      continue;
    }
    writeFileSync(path, body, "utf-8");
    written.push({ path, slug: final, occurrences: cluster.occurrences });
  }
  return { written, skipped };
}
