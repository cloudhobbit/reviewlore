// GitHub Copilot renderer: writes a single
// <target>/.github/copilot-instructions.md file. Copilot supports
// repo-level custom instructions via this path:
//   https://docs.github.com/en/copilot/customizing-copilot/about-customizing-github-copilot-chat-responses
//
// Unlike Claude/Cursor (one file per rule), Copilot reads a single
// instructions file. We render all kept clusters into sections.

import { writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const name = "copilot";
export const describe = "GitHub Copilot: single <target>/.github/copilot-instructions.md";

const MARKER_START = "<!-- reviewlore:start -->";
const MARKER_END = "<!-- reviewlore:end -->";

function pickRepSentence(items) {
  return [...items]
    .filter((i) => i.sentence.length >= 25 && i.sentence.length <= 200)
    .sort((a, b) => a.sentence.length - b.sentence.length)[0]?.sentence
    ?? items[0]?.sentence ?? "";
}

function renderSection(cluster, synth) {
  const useSynth = synth && !synth._error && synth.name !== "INCOHERENT";
  const title = useSynth ? synth.name : (cluster.label.join(" / ") || "Review feedback");
  const rule = useSynth ? synth.rule : pickRepSentence(cluster.items);
  const why = useSynth
    ? synth.why
    : `Recurred ${cluster.occurrences}× across ${cluster.distinctAuthors} reviewers on ${cluster.distinctPRs} PRs.`;
  const when = useSynth
    ? synth.when_to_apply
    : ((cluster.paths ?? []).length
        ? `When editing files matching: ${cluster.paths.slice(0, 4).join(", ")}.`
        : "When editing any file in this repository.");
  return `### ${title}\n\n${rule}\n\n- **Why:** ${why}\n- **When:** ${when}\n`;
}

function renderBlock(clusters, synth) {
  const lines = [
    MARKER_START,
    "## Recurring reviewer feedback",
    "",
    "_Generated from this repository's PR review history by [reviewlore](https://github.com/cloudhobbit/reviewlore). Edit between the markers will be overwritten on next regeneration; edits outside the markers are preserved._",
    "",
  ];
  for (let i = 0; i < clusters.length; i++) {
    lines.push(renderSection(clusters[i], synth?.[i]));
  }
  lines.push(MARKER_END);
  return lines.join("\n");
}

export function write(clusters, { targetDir, force = false, synth = null } = {}) {
  const dir = join(targetDir, ".github");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "copilot-instructions.md");

  const block = renderBlock(clusters, synth);

  let final;
  if (existsSync(path)) {
    const current = readFileSync(path, "utf-8");
    const markerRe = new RegExp(
      `${MARKER_START}[\\s\\S]*?${MARKER_END}`,
      "m",
    );
    if (markerRe.test(current)) {
      // Replace our managed block in place; preserve any surrounding text.
      final = current.replace(markerRe, () => block); // a function: "$" in rule text stays literal
    } else if (force) {
      // No managed block AND --force: append.
      final = `${current.trimEnd()}\n\n${block}\n`;
    } else {
      // File exists but no markers — refuse without --force to protect
      // user-written content.
      return {
        written: [],
        skipped: [{ path, slug: "copilot-instructions", occurrences: clusters.length }],
      };
    }
  } else {
    final = `${block}\n`;
  }

  writeFileSync(path, final, "utf-8");
  return {
    written: [{ path, slug: "copilot-instructions", occurrences: clusters.length }],
    skipped: [],
  };
}
