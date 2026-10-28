import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadCache, mergeIntoCache, incrementalSince } from "../lib/cache.mjs";

function withTmpCache(fn) {
  const dir = mkdtempSync(join(tmpdir(), "pr-cache-"));
  const old = process.env.REVIEWLORE_CACHE_DIR;
  process.env.REVIEWLORE_CACHE_DIR = dir;
  try {
    return fn(dir);
  } finally {
    if (old !== undefined) process.env.REVIEWLORE_CACHE_DIR = old;
    else delete process.env.REVIEWLORE_CACHE_DIR;
    rmSync(dir, { recursive: true, force: true });
  }
}

test("loadCache: returns null when no cache exists", () => {
  withTmpCache(() => {
    assert.equal(loadCache("a", "b"), null);
    assert.equal(incrementalSince("a", "b"), null);
  });
});

test("mergeIntoCache: writes first entry verbatim", () => {
  withTmpCache(() => {
    const output = {
      meta: { owner: "a", repo: "b", fetched_at: "2026-01-01T00:00:00Z" },
      issue_comments: [{ comment_id: 1, body: "x" }],
      review_comments: [],
      review_submissions: [],
    };
    mergeIntoCache("a", "b", output);
    const c = loadCache("a", "b");
    assert.equal(c.issue_comments.length, 1);
    assert.equal(c.meta.last_fetched_at, "2026-01-01T00:00:00Z");
  });
});

test("mergeIntoCache: dedups by comment_id and review_id (later wins)", () => {
  withTmpCache(() => {
    mergeIntoCache("a", "b", {
      meta: { fetched_at: "2026-01-01T00:00:00Z" },
      issue_comments: [{ comment_id: 1, body: "original" }],
      review_comments: [],
      review_submissions: [{ review_id: 10, body: "r-original" }],
    });
    mergeIntoCache("a", "b", {
      meta: { fetched_at: "2026-02-01T00:00:00Z" },
      issue_comments: [
        { comment_id: 1, body: "updated" },
        { comment_id: 2, body: "new" },
      ],
      review_comments: [],
      review_submissions: [
        { review_id: 10, body: "r-updated" },
        { review_id: 11, body: "r-new" },
      ],
    });
    const c = loadCache("a", "b");
    assert.equal(c.issue_comments.length, 2);
    assert.equal(c.issue_comments.find((x) => x.comment_id === 1).body, "updated");
    assert.equal(c.review_submissions.length, 2);
    assert.equal(c.meta.last_fetched_at, "2026-02-01T00:00:00Z");
  });
});

test("mergeIntoCache: merges pr_authors maps across runs", () => {
  withTmpCache(() => {
    mergeIntoCache("a", "b", {
      meta: { fetched_at: "2026-01-01T00:00:00Z", pr_authors: { 1: "alice", 2: "bob" } },
      issue_comments: [], review_comments: [], review_submissions: [],
    });
    mergeIntoCache("a", "b", {
      meta: { fetched_at: "2026-02-01T00:00:00Z", pr_authors: { 3: "carol" } },
      issue_comments: [], review_comments: [], review_submissions: [],
    });
    const c = loadCache("a", "b");
    assert.deepEqual(c.meta.pr_authors, { 1: "alice", 2: "bob", 3: "carol" });
  });
});

test("incrementalSince: returns last_fetched_at as Date", () => {
  withTmpCache(() => {
    mergeIntoCache("a", "b", {
      meta: { fetched_at: "2026-03-15T12:00:00Z" },
      issue_comments: [], review_comments: [], review_submissions: [],
    });
    const since = incrementalSince("a", "b");
    assert.ok(since instanceof Date);
    assert.equal(since.toISOString(), "2026-03-15T12:00:00.000Z");
  });
});

test("mergeIntoCache keeps the earliest window start across incremental merges", () => {
  withTmpCache(() => {
    const empty = { issue_comments: [], review_comments: [], review_submissions: [] };
    mergeIntoCache("a", "b", { meta: { since: "2025-10-01T00:00:00Z", months_back: 6, fetched_at: "2026-04-01T00:00:00Z" }, ...empty });
    mergeIntoCache("a", "b", { meta: { since: "2026-04-01T00:00:00Z", months_back: 6, fetched_at: "2026-04-08T00:00:00Z" }, ...empty });
    const c = loadCache("a", "b");
    assert.equal(c.meta.since, "2025-10-01T00:00:00Z");
    assert.equal(c.meta.last_fetched_at, "2026-04-08T00:00:00Z");
  });
});

test("incrementalSince returns null when the cache doesn't reach back to the requested window", () => {
  withTmpCache(() => {
    mergeIntoCache("a", "b", {
      meta: { since: "2025-10-01T00:00:00Z", fetched_at: "2026-04-01T00:00:00Z" },
      issue_comments: [], review_comments: [], review_submissions: [],
    });
    // 6 months requested: covered → incremental from last fetch.
    assert.equal(incrementalSince("a", "b", new Date("2025-11-01T00:00:00Z")).toISOString(), "2026-04-01T00:00:00.000Z");
    // 12 months requested: not covered → fetch the whole window (backfill).
    assert.equal(incrementalSince("a", "b", new Date("2025-04-01T00:00:00Z")), null);
  });
});

test("cache files are kept apart per GitHub host; github.com keeps its old path", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { cachePath, mergeIntoCache, loadCache, partialPath } = await import("../lib/cache.mjs");
  const dir = mkdtempSync(join(tmpdir(), "cache-hosts-"));
  const before = process.env.REVIEWLORE_CACHE_DIR;
  process.env.REVIEWLORE_CACHE_DIR = dir;
  try {
    assert.equal(cachePath("acme", "app"), join(dir, "acme__app.json"));
    assert.equal(cachePath("acme", "app", "ghe.corp:8443"), join(dir, "hosts", "ghe.corp_8443", "acme__app.json"));
    assert.equal(partialPath("acme", "app", "ghe.corp"), join(dir, "hosts", "ghe.corp", "acme__app.partial.json"));
    const out = (host, n) => ({ meta: { owner: "acme", repo: "app", fetched_at: "2026-10-01T00:00:00Z", ...(host ? { host } : {}) }, issue_comments: [{ comment_id: n, body: "x" }], review_comments: [], review_submissions: [] });
    mergeIntoCache("acme", "app", out(null, 1));
    mergeIntoCache("acme", "app", out("ghe.corp", 2)); // host taken from meta
    assert.deepEqual(loadCache("acme", "app").issue_comments.map((c) => c.comment_id), [1]);
    assert.deepEqual(loadCache("acme", "app", "ghe.corp").issue_comments.map((c) => c.comment_id), [2]);
  } finally {
    if (before === undefined) delete process.env.REVIEWLORE_CACHE_DIR;
    else process.env.REVIEWLORE_CACHE_DIR = before;
    rmSync(dir, { recursive: true, force: true });
  }
});
