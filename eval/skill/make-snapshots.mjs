#!/usr/bin/env node
// Rebuilds eval/skill/snapshots/<repo>.candidates.json from cached corpora,
// for the gallery check (`npm run eval:skill`).
//
//   node eval/skill/make-snapshots.mjs <cache-dir>
//
// <cache-dir> holds <owner>__<repo>.json files (the reviewlore cache, e.g.
// ~/.reviewlore). Runs `candidates` offline: the corpus is passed as a
// committed corpus, the cache is disabled, there is no token and only
// `node` is on PATH, so nothing can reach GitHub.
//
// Only clusters that a gallery rule cites are kept, so the snapshots carry
// no reviewer handles beyond the ones the gallery already shows. Re-run
// after changing the extraction pipeline or regenerating the gallery.

import { spawnSync } from "node:child_process";
import {
  mkdtempSync, copyFileSync, rmSync, readdirSync, readFileSync, writeFileSync, existsSync, symlinkSync, mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const GALLERY = { vitest: "vitest-dev/vitest", pnpm: "pnpm/pnpm", express: "expressjs/express" };

const here = fileURLToPath(new URL(".", import.meta.url));
const root = resolve(here, "../..");
const cacheDir = process.argv[2];
if (!cacheDir) {
  console.error("Usage: make-snapshots.mjs <cache-dir>");
  process.exit(1);
}

function citedUrls(repo) {
  const dir = join(root, "examples/real-repos", repo, "plugin/.claude/rules");
  const urls = new Set();
  for (const f of readdirSync(dir)) {
    for (const m of readFileSync(join(dir, f), "utf-8").matchAll(/ on PR #\d+: (https:\/\/\S+)/g)) urls.add(m[1]);
  }
  return urls;
}

const work = mkdtempSync(join(tmpdir(), "rl-snapshots-"));
try {
  const bin = join(work, "bin");
  mkdirSync(bin);
  symlinkSync(process.execPath, join(bin, "node"));
  mkdirSync(join(here, "snapshots"), { recursive: true });

  for (const [name, slug] of Object.entries(GALLERY)) {
    const [owner, repo] = slug.split("/");
    const source = join(cacheDir, `${owner}__${repo}.json`);
    if (!existsSync(source)) {
      console.error(`${name}: ${source} not found, skipped`);
      continue;
    }
    const target = join(work, name);
    mkdirSync(target);
    copyFileSync(source, join(target, ".reviewlore-corpus.json"));
    const r = spawnSync(join(bin, "node"), [
      join(root, "cli/reviewlore.mjs"), "candidates", "--owner", owner, "--repo", repo,
      "--target", target, "--no-cache", "--limit", "5000",
    ], {
      encoding: "utf-8",
      maxBuffer: 256 * 1024 * 1024,
      env: { PATH: bin, GITHUB_TOKEN: "", REVIEWLORE_CACHE_DIR: join(work, "cache") },
    });
    if (r.status !== 0) {
      console.error(`${name}: candidates failed\n${r.stderr}`);
      process.exitCode = 1;
      continue;
    }
    const out = JSON.parse(r.stdout);
    const urls = citedUrls(name);
    const clusters = out.clusters.filter((c) => c.quotes.some((q) => urls.has(q.url)));
    const snapshot = {
      note: "Clusters from `reviewlore candidates` that the gallery rules cite. Rebuild with eval/skill/make-snapshots.mjs.",
      repo: out.repo,
      since: out.since,
      stats: out.stats,
      clusters,
    };
    const lines = JSON.stringify({ ...snapshot, clusters: [] }).slice(0, -3);
    writeFileSync(
      join(here, "snapshots", `${name}.candidates.json`),
      `${lines}[\n${clusters.map((c) => JSON.stringify(c)).join(",\n")}\n]}\n`,
    );
    console.error(`${name}: ${clusters.length} cited clusters of ${out.stats.clusters}`);
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
