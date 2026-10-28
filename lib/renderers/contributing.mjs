// Plain-Markdown CONTRIBUTING renderer: appends/updates a managed section
// in <target>/CONTRIBUTING.md. AI-tool-agnostic — useful as a human-facing
// contribution guide and as broad context for any AI assistant that reads
// repository markdown.

import { writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const name = "contributing";
export const describe = "CONTRIBUTING.md: appends a managed 'Recurring review feedback' section";

const MARKER_START = "<!-- reviewlore:start -->";
const MARKER_END = "<!-- reviewlore:end -->";

function pickRepSentence(items) {
  return [...items]
    .filter((i) => i.sentence.length >= 25 && i.sentence.length <= 200)
    .sort((a, b) => a.sentence.length - b.sentence.length)[0]?.sentence
    ?? items[0]?.sentence ?? "";
}

function renderBullet(cluster, synth) {
  const useSynth = synth && !synth._error && synth.name !== "INCOHERENT";
  const title = useSynth ? synth.name : (cluster.label.join(" / ") || "Review feedback");
  const rule = useSynth ? synth.rule : pickRepSentence(cluster.items);
  const exampleLink = cluster.items[0]?.url
    ? ` ([example](${cluster.items[0].url}))`
    : "";
  return `- **${title}** — ${rule} _(${cluster.occurrences}× across ${cluster.distinctAuthors} reviewers${exampleLink})_`;
}

function renderBlock(clusters, synth) {
  const lines = [
    MARKER_START,
    "## Recurring review feedback",
    "",
    "_Auto-generated from this repository's PR review history. Edit between the markers will be overwritten on next regeneration._",
    "",
  ];
  for (let i = 0; i < clusters.length; i++) {
    lines.push(renderBullet(clusters[i], synth?.[i]));
  }
  lines.push("");
  lines.push(MARKER_END);
  return lines.join("\n");
}

export function write(clusters, { targetDir, force = false, synth = null } = {}) {
  const path = join(targetDir, "CONTRIBUTING.md");
  const block = renderBlock(clusters, synth);
  let final;

  if (existsSync(path)) {
    const current = readFileSync(path, "utf-8");
    const markerRe = new RegExp(`${MARKER_START}[\\s\\S]*?${MARKER_END}`, "m");
    if (markerRe.test(current)) {
      final = current.replace(markerRe, block);
    } else if (force) {
      final = `${current.trimEnd()}\n\n${block}\n`;
    } else {
      return {
        written: [],
        skipped: [{ path, slug: "contributing", occurrences: clusters.length }],
      };
    }
  } else {
    // Fresh file gets a tiny header so it's not just our managed block.
    final = `# Contributing\n\n${block}\n`;
  }

  writeFileSync(path, final, "utf-8");
  return {
    written: [{ path, slug: "contributing", occurrences: clusters.length }],
    skipped: [],
  };
}
