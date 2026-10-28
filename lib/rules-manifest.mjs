// .claude/reviewlore-rules.json: which rules reviewlore wrote, from what
// evidence, and what the file looked like then (docs/plans/10-keeping-rules-fresh.md).
//
// A sidecar rather than frontmatter: Claude Code reads only `paths` from a
// rule and a YAML slip in a hand edit would make the rule load everywhere;
// a committed JSON file costs no context and shows up in PR diffs.
// Written only when its content changes, keys sorted, so it never churns.

import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { parseRuleFile } from "./rule-files.mjs";

export const MANIFEST_FILE = ".claude/reviewlore-rules.json";
export const GENERATORS = ["learn-from-reviews", "heuristic", "heuristic+llm"];

export const manifestPath = (targetDir) => join(targetDir, MANIFEST_FILE);

export function emptyManifest(repo = null) {
  return { version: 1, repo, rules: {}, dismissed: [] };
}

export function loadManifest(targetDir) {
  const path = manifestPath(targetDir);
  if (!existsSync(path)) return null;
  try {
    const m = JSON.parse(readFileSync(path, "utf-8"));
    return m?.version === 1 && m.rules ? { dismissed: [], ...m } : null;
  } catch {
    return null;
  }
}

// Stable JSON: object keys sorted at every level.
function sorted(value) {
  if (Array.isArray(value)) return value.map(sorted);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((k) => [k, sorted(value[k])]));
  }
  return value;
}

// Returns true if the file changed.
export function saveManifest(targetDir, manifest) {
  const text = `${JSON.stringify(sorted(manifest), null, 2)}\n`;
  const path = manifestPath(targetDir);
  if (existsSync(path) && readFileSync(path, "utf-8") === text) return false;
  mkdirSync(join(targetDir, ".claude"), { recursive: true });
  writeFileSync(path, text, "utf-8");
  return true;
}

export const TOOL_VERSION = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf-8")).version;

export const fileSha = (text) => createHash("sha256").update(text.replace(/\r\n/g, "\n")).digest("hex");

// The manifest entry for a rule file as written now. `byUrl` maps review
// URLs to { pr, author, created_at } from the history; `ctx` says which
// data it came from. Keeps `created` from an earlier entry.
export function entryFor(text, fileName, { generator, query, byUrl = new Map(), ctx = {}, previous, today, toolVersion }) {
  const rule = parseRuleFile(text, fileName);
  if (!rule) return null;
  const evidence = rule.examples
    .map((e) => ({ url: e.url, pr: e.pr, author: e.author, at: byUrl.get(e.url)?.created_at?.slice(0, 10) ?? null }))
    .sort((a, b) => (a.url < b.url ? -1 : a.url > b.url ? 1 : 0));
  return {
    generator: generator ?? previous?.generator ?? "learn-from-reviews",
    status: "active",
    created: previous?.created ?? today,
    refreshed: today,
    tool_version: toolVersion,
    corpus: { source: ctx.source ?? null, fetched_at: ctx.fetchedAt ?? null },
    globs: rule.paths,
    ...(query ?? previous?.query ? { query: query ?? previous.query } : {}),
    title: rule.title,
    evidence,
    support: { prs: new Set(evidence.map((e) => e.pr)).size, reviewers: new Set(evidence.map((e) => e.author)).size },
    sha256: fileSha(text),
  };
}

// Upsert entries for rule files under <targetDir>/.claude/rules and save.
// Returns { recorded: [names], skipped: [names that aren't reviewlore rules] }.
export function recordFiles(targetDir, names, { generator, query, byUrl, ctx = {}, now = new Date() } = {}) {
  const manifest = loadManifest(targetDir) ?? emptyManifest(ctx.owner ? `${ctx.owner}/${ctx.repo}` : null);
  const today = now.toISOString().slice(0, 10);
  const recorded = [];
  const skipped = [];
  for (const name of names) {
    const path = join(targetDir, ".claude", "rules", name);
    const text = existsSync(path) ? readFileSync(path, "utf-8") : null;
    const entry = text && entryFor(text, name, { generator, query, byUrl, ctx, previous: manifest.rules[name], today, toolVersion: TOOL_VERSION });
    if (!entry) {
      skipped.push(name);
      continue;
    }
    manifest.rules[name] = entry;
    recorded.push(name);
  }
  if (ctx.owner && !manifest.repo) manifest.repo = `${ctx.owner}/${ctx.repo}`;
  if (recorded.length) saveManifest(targetDir, manifest);
  return { recorded, skipped };
}

// Review URL → { created_at } for evidence dates, from fetched data.
export function urlDates(data) {
  const map = new Map();
  for (const c of [...(data?.issue_comments ?? []), ...(data?.review_comments ?? []), ...(data?.review_submissions ?? [])]) {
    if (c.html_url) map.set(c.html_url, { created_at: c.created_at ?? c.submitted_at ?? null });
  }
  return map;
}
