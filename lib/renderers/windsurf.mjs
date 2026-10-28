// Windsurf (Codeium) renderer: writes <target>/.windsurfrules — a single
// plain-text rules file that Windsurf reads as system-level guidance.
// (https://docs.codeium.com/windsurf/cascade)
//
// No frontmatter; numbered rules, each with a short rationale.

import { writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { normalizeAll } from "./_common.mjs";

export const name = "windsurf";
export const describe = "Windsurf (Codeium): managed block in <target>/.windsurfrules";

const MARKER_START = "# >>> reviewlore start";
const MARKER_END = "# <<< reviewlore end";

function renderRule(rule, idx) {
  return [
    `${idx + 1}. ${rule.title}`,
    `   ${rule.body}`,
    `   Why: ${rule.why}`,
    `   When: ${rule.when_to_apply}`,
    "",
  ].join("\n");
}

function renderBlock(rules) {
  return [
    MARKER_START,
    "# Recurring reviewer feedback (auto-generated; edit between markers will be overwritten)",
    "",
    ...rules.map(renderRule),
    MARKER_END,
  ].join("\n");
}

export function write(clusters, { targetDir, force = false, synth = null } = {}) {
  const rules = normalizeAll(clusters, synth);
  const path = join(targetDir, ".windsurfrules");
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
      return { written: [], skipped: [{ path, slug: "windsurf", occurrences: clusters.length }] };
    }
  } else {
    final = `${block}\n`;
  }
  writeFileSync(path, final, "utf-8");
  return { written: [{ path, slug: "windsurf", occurrences: clusters.length }], skipped: [] };
}
