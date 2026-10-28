import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const LIB_CACHE = resolve(
  fileURLToPath(new URL(".", import.meta.url)),
  "..",
  "lib",
  "cache.mjs",
);

// Spawn a child that performs N back-to-back mergeIntoCache calls with a
// disjoint comment_id range. Two of these run concurrently in the test
// below; without atomic-rename + lock, the second writer races the first
// and loses comments (or the file is half-written and loadCache returns
// null on next run).
function childScript(prefix, count) {
  return `
    import { mergeIntoCache, loadCache } from ${JSON.stringify(pathToFileURL(LIB_CACHE).href)};
    const PREFIX = ${JSON.stringify(prefix)};
    const COUNT = ${count};
    for (let i = 0; i < COUNT; i++) {
      mergeIntoCache("o", "r", {
        meta: { fetched_at: new Date().toISOString() },
        issue_comments: [{ comment_id: \`\${PREFIX}-\${i}\`, body: "x" }],
        review_comments: [],
        review_submissions: [],
      });
    }
    // Sanity: cache must still parse from this process's POV.
    const c = loadCache("o", "r");
    if (!c) { console.error("cache parse failed"); process.exit(2); }
  `;
}

function runChild(dir, prefix, count) {
  return spawnSync(process.execPath, ["--input-type=module", "-e", childScript(prefix, count)], {
    env: { ...process.env, REVIEWLORE_CACHE_DIR: dir },
    encoding: "utf-8",
  });
}

test("concurrent mergeIntoCache from two processes preserves all writes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pr-cache-race-"));
  try {
    const COUNT = 20;
    // Fire both children in parallel via Promise.all — spawnSync blocks
    // the worker but Promise.all schedules both spawns before either
    // returns, so kernel-level the two writers run concurrently.
    const [a, b] = await Promise.all([
      Promise.resolve().then(() => runChild(dir, "A", COUNT)),
      Promise.resolve().then(() => runChild(dir, "B", COUNT)),
    ]);
    assert.equal(a.status, 0, `child A failed: ${a.stderr}`);
    assert.equal(b.status, 0, `child B failed: ${b.stderr}`);

    const cachePath = join(dir, "o__r.json");
    assert.ok(existsSync(cachePath), "cache file should exist");
    const raw = readFileSync(cachePath, "utf-8");
    // Must be valid JSON — the bug manifested as truncated/partial files
    // that JSON.parse rejected, which loadCache silently swallowed.
    const parsed = JSON.parse(raw);

    const ids = new Set(parsed.issue_comments.map((c) => c.comment_id));
    // Union of both writers' contributions must survive.
    for (let i = 0; i < COUNT; i++) {
      assert.ok(ids.has(`A-${i}`), `missing A-${i} — writer A's data was clobbered`);
      assert.ok(ids.has(`B-${i}`), `missing B-${i} — writer B's data was clobbered`);
    }
    assert.equal(parsed.issue_comments.length, COUNT * 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("saveCache write is atomic — no temp leftovers on success", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pr-cache-atomic-"));
  try {
    const r = runChild(dir, "X", 3);
    assert.equal(r.status, 0, r.stderr);
    const { readdirSync } = await import("node:fs");
    const files = readdirSync(dir);
    const tmps = files.filter((f) => f.includes(".tmp."));
    assert.deepEqual(tmps, [], `no temp files should remain, found: ${tmps.join(", ")}`);
    const locks = files.filter((f) => f.endsWith(".lock"));
    assert.deepEqual(locks, [], `no lock files should remain, found: ${locks.join(", ")}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

