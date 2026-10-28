#!/usr/bin/env node
// Builds lib/fixtures/demo-candidates.json, the bundled output of
// `reviewlore candidates --demo` (the plugin's `/learn-from-reviews demo`).
//
//   node scripts/make-demo-fixture.mjs <cache-dir>
//
// <cache-dir> holds vitest-dev__vitest.json (the reviewlore cache, e.g.
// ~/.reviewlore). `candidates` runs offline: the cached history is passed
// as a committed corpus, the cache is off, there is no token and only
// `node` is on PATH. Reviewer handles are replaced with per-file
// pseudonyms (user-1, user-2, … in order of first appearance), as in
// eval/real: the fixture ships in the npm package, and the demo needs
// distinct reviewers, not their names. URLs still link to the public
// comments.

import { spawnSync } from "node:child_process";
import { mkdtempSync, copyFileSync, rmSync, writeFileSync, readFileSync, existsSync, symlinkSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const OWNER = "vitest-dev";
const REPO = "vitest";
const LIMIT = 60;
const MAX_BYTES = 64 * 1024;

const root = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const cacheDir = process.argv[2];
if (!cacheDir) {
  console.error("Usage: make-demo-fixture.mjs <cache-dir>");
  process.exit(1);
}
const source = join(cacheDir, `${OWNER}__${REPO}.json`);
if (!existsSync(source)) {
  console.error(`${source} not found`);
  process.exit(1);
}

const work = mkdtempSync(join(tmpdir(), "rl-demo-fixture-"));
try {
  const bin = join(work, "bin");
  mkdirSync(bin);
  symlinkSync(process.execPath, join(bin, "node"));
  const target = join(work, "repo");
  mkdirSync(target);
  copyFileSync(source, join(target, ".reviewlore-corpus.json"));
  const r = spawnSync(join(bin, "node"), [
    join(root, "cli/reviewlore.mjs"), "candidates", "--owner", OWNER, "--repo", REPO,
    "--target", target, "--no-cache", "--limit", String(LIMIT),
  ], { encoding: "utf-8", env: { PATH: bin, GITHUB_TOKEN: "", REVIEWLORE_CACHE_DIR: join(work, "cache") } });
  if (r.status !== 0) {
    console.error(r.stderr);
    process.exit(1);
  }
  const out = JSON.parse(r.stdout);

  const pseudonyms = new Map();
  const alias = (login) => {
    if (!pseudonyms.has(login)) pseudonyms.set(login, `user-${pseudonyms.size + 1}`);
    return pseudonyms.get(login);
  };
  for (const c of out.clusters) for (const q of c.quotes) q.author = alias(q.author);

  const fetched = JSON.parse(readFileSync(source, "utf-8")).meta?.last_fetched_at?.slice(0, 10) ?? "unknown";
  const head = {
    demo: true,
    source: `Public PR review history of ${OWNER}/${REPO}, fetched ${fetched}; ` +
      "reviewer handles replaced with pseudonyms. Rebuild with scripts/make-demo-fixture.mjs.",
    repo: out.repo,
    since: out.since,
    stats: out.stats,
    history: out.history,
    // The demo has no repository of its own to compare against.
    existing_instructions: [],
  };
  const text = `${JSON.stringify(head).slice(0, -1)},"clusters":[\n${out.clusters.map((c) => JSON.stringify(c)).join(",\n")}\n]}\n`;
  if (Buffer.byteLength(text) > MAX_BYTES) {
    console.error(`fixture is ${Buffer.byteLength(text)} bytes; lower LIMIT to stay under ${MAX_BYTES}`);
    process.exit(1);
  }
  const dest = join(root, "lib/fixtures/demo-candidates.json");
  writeFileSync(dest, text);
  console.error(`wrote ${dest}: ${out.clusters.length} clusters, ${pseudonyms.size} reviewers, ${Buffer.byteLength(text)} bytes`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
