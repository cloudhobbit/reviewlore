// AGENTS.md renderer: the emerging cross-tool convention
// (https://agents.md/). One file at the repo root that any
// agent-capable tool reads — OpenAI Codex, Continue, Aider, several
// others honour it.
//
// Single file at <target>/AGENTS.md with a managed block.

import { writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { normalizeAll } from "./_common.mjs";

export const name = "agents";
export const describe = "AGENTS.md (cross-tool standard): managed section in <target>/AGENTS.md";

const MARKER_START = "<!-- reviewlore:start -->";
const MARKER_END = "<!-- reviewlore:end -->";

function renderSection(rule) {
  return [
    `### ${rule.title}`,
    "",
    rule.body,
    "",
    `**Why:** ${rule.why}`,
    "",
    `**When to apply:** ${rule.when_to_apply}`,
    "",
  ].join("\n");
}

function renderBlock(rules) {
  return [
    MARKER_START,
    "## Recurring reviewer feedback",
    "",
    "_Auto-generated from PR review history. Content between the markers will be overwritten on next regeneration; surrounding prose is preserved._",
    "",
    ...rules.map(renderSection),
    MARKER_END,
  ].join("\n");
}

export function write(clusters, { targetDir, force = false, synth = null } = {}) {
  const rules = normalizeAll(clusters, synth);
  const path = join(targetDir, "AGENTS.md");
  const block = renderBlock(rules);
  let final;
  if (existsSync(path)) {
    const current = readFileSync(path, "utf-8");
    const markerRe = new RegExp(`${MARKER_START}[\\s\\S]*?${MARKER_END}`, "m");
    if (markerRe.test(current)) {
      final = current.replace(markerRe, block);
    } else if (force) {
      final = `${current.trimEnd()}\n\n${block}\n`;
    } else {
      return { written: [], skipped: [{ path, slug: "agents", occurrences: clusters.length }] };
    }
  } else {
    final = `# Agents\n\nProject guidance for AI coding agents.\n\n${block}\n`;
  }
  writeFileSync(path, final, "utf-8");
  return { written: [{ path, slug: "agents", occurrences: clusters.length }], skipped: [] };
}
