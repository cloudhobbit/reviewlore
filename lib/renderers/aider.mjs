// Aider renderer: appends/updates a managed section in
// <target>/CONVENTIONS.md — the file Aider reads via its `read:` config
// directive (https://aider.chat/docs/usage/conventions.html).
//
// Single file (like Copilot), prose body (like CONTRIBUTING). Reuses
// the same managed-block pattern so user-written conventions outside
// the markers are preserved on re-runs.

import { writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { normalizeAll } from "./_common.mjs";

export const name = "aider";
export const describe = "Aider: managed section in <target>/CONVENTIONS.md (used via aider --read CONVENTIONS.md)";

const MARKER_START = "<!-- reviewlore:start -->";
const MARKER_END = "<!-- reviewlore:end -->";

function renderSection(rule) {
  return [
    `### ${rule.title}`,
    "",
    rule.body,
    "",
    `- **Why:** ${rule.why}`,
    `- **When:** ${rule.when_to_apply}`,
    `- **Severity:** ${rule.severity}`,
    "",
  ].join("\n");
}

function renderBlock(rules) {
  return [
    MARKER_START,
    "## Recurring reviewer feedback",
    "",
    "_Generated from PR review history. The block between the markers is auto-managed; edit between markers will be overwritten._",
    "",
    ...rules.map(renderSection),
    MARKER_END,
  ].join("\n");
}

export function write(clusters, { targetDir, force = false, synth = null } = {}) {
  const rules = normalizeAll(clusters, synth);
  const path = join(targetDir, "CONVENTIONS.md");
  const block = renderBlock(rules);
  let final;
  if (existsSync(path)) {
    const current = readFileSync(path, "utf-8");
    const markerRe = new RegExp(`${MARKER_START}[\\s\\S]*?${MARKER_END}`, "m");
    if (markerRe.test(current)) {
      final = current.replace(markerRe, () => block); // a function: "$" in rule text stays literal
    } else if (force) {
      final = `${current.trimEnd()}\n\n${block}\n`;
    } else {
      return { written: [], skipped: [{ path, slug: "aider", occurrences: clusters.length }] };
    }
  } else {
    final = `# Conventions\n\n${block}\n`;
  }
  writeFileSync(path, final, "utf-8");
  return { written: [{ path, slug: "aider", occurrences: clusters.length }], skipped: [] };
}
