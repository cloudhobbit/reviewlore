#!/usr/bin/env node
// How well search_review_feedback finds the comments behind real rules
// (docs/plans/06-useful-mcp-server.md). For each gallery rule written by
// the plugin, search with the rule's title (rule files left out, so only
// the comment search is measured) and check whether the comments the rule
// cites come back in the top 5.
//
//   node eval/search-gallery.mjs <cache-dir>
//
// <cache-dir> holds <owner>__<repo>.json for the gallery repos (the
// reviewlore cache). Not in CI: the cache isn't committed.

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildIndex, searchIndex } from "../lib/review-index.mjs";
import { listGeneratedRules } from "../lib/rule-files.mjs";

const GALLERY = { vitest: "vitest-dev__vitest", pnpm: "pnpm__pnpm", express: "expressjs__express" };
const root = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const cacheDir = process.argv[2];
if (!cacheDir) {
  console.error("Usage: search-gallery.mjs <cache-dir>");
  process.exit(1);
}

let rulesHit = 0;
let rulesTotal = 0;
let quotesHit = 0;
let quotesTotal = 0;
for (const [name, file] of Object.entries(GALLERY)) {
  const path = join(cacheDir, `${file}.json`);
  if (!existsSync(path)) {
    console.error(`${name}: ${path} not found, skipped`);
    continue;
  }
  const index = buildIndex(JSON.parse(readFileSync(path, "utf-8")));
  for (const rule of listGeneratedRules(join(root, "examples/real-repos", name, "plugin"))) {
    const top = new Set(searchIndex(index, rule.title, { limit: 5 }).results.map((r) => r.url));
    const cited = rule.examples.map((e) => e.url);
    const found = cited.filter((u) => top.has(u)).length;
    rulesTotal++;
    quotesTotal += cited.length;
    quotesHit += found;
    if (found) rulesHit++;
    console.log(`${found ? "✓" : "✗"} ${name.padEnd(8)} ${String(found)}/${cited.length}  ${rule.title}`);
  }
}
console.log(`\nRules with a cited comment in the top 5: ${rulesHit}/${rulesTotal}`);
console.log(`Cited comments found in the top 5: ${quotesHit}/${quotesTotal}`);
