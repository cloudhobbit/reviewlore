// Output-format registry. Each renderer implements:
//
//   {
//     name: "claude" | "cursor" | "copilot" | "contributing" | "json",
//     describe: string,         // shown in --help / errors
//     // write(clusters, opts) writes files into opts.targetDir and
//     // returns { written: [{path, label, occurrences}], skipped: [...] }
//     write(clusters, { targetDir, force, synth }) → { written, skipped }
//   }

import { existsSync } from "node:fs";
import { join } from "node:path";
import * as claude from "./claude.mjs";
import * as cursor from "./cursor.mjs";
import * as copilot from "./copilot.mjs";
import * as contributing from "./contributing.mjs";
import * as json from "./json.mjs";
import * as html from "./html.mjs";
import * as aider from "./aider.mjs";
import * as agents from "./agents.mjs";
import * as windsurf from "./windsurf.mjs";

const RENDERERS = {
  claude, cursor, copilot, contributing, json, html, aider, agents, windsurf,
};

export function getRenderer(name) {
  const r = RENDERERS[name];
  if (!r) {
    throw new Error(
      `Unknown format "${name}". Supported: ${Object.keys(RENDERERS).join(", ")}, auto, all`,
    );
  }
  return r;
}

export function rendererNames() {
  return Object.keys(RENDERERS);
}

export function rendererSummary() {
  return Object.entries(RENDERERS)
    .map(([k, v]) => `  ${k.padEnd(14)} ${v.describe}`)
    .join("\n");
}

// Auto-detect which renderers are appropriate for a target directory by
// looking for telltale config files / directories of each AI tool. Returns
// an array of renderer names (always at least one — falls back to claude).
//
// Detection signals (each presence triggers the matching renderer):
//   .claude/                            → claude
//   .cursor/                            → cursor
//   .github/copilot-instructions.md     → copilot
//   .windsurfrules                      → windsurf
//   CONVENTIONS.md                      → aider
//   AGENTS.md                           → agents
//   CONTRIBUTING.md (always available)  → contributing  (only if nothing else matched)
export function detectFormats(targetDir) {
  const detected = [];
  if (existsSync(join(targetDir, ".claude"))) detected.push("claude");
  if (existsSync(join(targetDir, ".cursor"))) detected.push("cursor");
  if (existsSync(join(targetDir, ".github", "copilot-instructions.md"))) detected.push("copilot");
  if (existsSync(join(targetDir, ".windsurfrules"))) detected.push("windsurf");
  if (existsSync(join(targetDir, "CONVENTIONS.md"))) detected.push("aider");
  if (existsSync(join(targetDir, "AGENTS.md"))) detected.push("agents");
  if (detected.length === 0) {
    // No AI tool conventions present — pick the most universal default.
    // If CONTRIBUTING.md exists we append to it; otherwise drop a Claude
    // rules dir (the historical default).
    if (existsSync(join(targetDir, "CONTRIBUTING.md"))) detected.push("contributing");
    else detected.push("claude");
  }
  return detected;
}

// Parse a --format value into a concrete list of renderer names.
// Supports:
//   --format claude              → ["claude"]
//   --format claude,cursor,html  → ["claude", "cursor", "html"]
//   --format all                 → every registered renderer
//   --format auto                → detectFormats(targetDir)
export function resolveFormats(formatArg, targetDir) {
  if (!formatArg || formatArg === "claude") return ["claude"];
  if (formatArg === "all") return rendererNames();
  if (formatArg === "auto") return detectFormats(targetDir);
  const requested = formatArg.split(",").map((s) => s.trim()).filter(Boolean);
  for (const name of requested) {
    if (!(name in RENDERERS)) {
      throw new Error(
        `Unknown format "${name}". Supported: ${Object.keys(RENDERERS).join(", ")}, auto, all`,
      );
    }
  }
  return requested;
}
