import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mergeIntoCache } from "../lib/cache.mjs";
import { listRepos, searchRules, recentFeedback } from "../lib/mcp-tools.mjs";

async function withTmpCache(fn) {
  const dir = mkdtempSync(join(tmpdir(), "mcp-test-"));
  const old = process.env.REVIEWLORE_CACHE_DIR;
  process.env.REVIEWLORE_CACHE_DIR = dir;
  try { return await fn(dir); } finally {
    if (old !== undefined) process.env.REVIEWLORE_CACHE_DIR = old;
    else delete process.env.REVIEWLORE_CACHE_DIR;
    rmSync(dir, { recursive: true, force: true });
  }
}

const baseCorpus = () => ({
  meta: { fetched_at: "2026-05-01T00:00:00Z", pr_authors: {} },
  issue_comments: [
    { comment_id: 1, pr_number: 1, author: "alice", body: "Please avoid any types here." },
    { comment_id: 2, pr_number: 2, author: "bob",   body: "Don't use any types in this code." },
    { comment_id: 3, pr_number: 3, author: "carol", body: "We shouldn't add any types in this file." },
    { comment_id: 4, pr_number: 4, author: "alice", body: "Please add tests for the empty array case." },
    { comment_id: 5, pr_number: 5, author: "bob",   body: "Missing test for the null input case." },
  ],
  review_comments: [
    { comment_id: 50, pr_number: 1, author: "alice", path: "src/api/users.ts",
      line: 10, body: "Use unknown not any.", created_at: "2026-04-15T00:00:00Z", html_url: "u50" },
    { comment_id: 51, pr_number: 2, author: "bob", path: "src/api/posts.ts",
      line: 20, body: "Avoid any in the response type.", created_at: "2026-04-20T00:00:00Z", html_url: "u51" },
  ],
  review_submissions: [],
});

test("listRepos: returns owner/repo pairs from cache dir", () => {
  return withTmpCache(async () => {
    mergeIntoCache("alice", "repo-a", baseCorpus());
    mergeIntoCache("bob", "repo-b", baseCorpus());
    const repos = listRepos();
    assert.equal(repos.length, 2);
    const labels = repos.map((r) => `${r.owner}/${r.repo}`).sort();
    assert.deepEqual(labels, ["alice/repo-a", "bob/repo-b"]);
  });
});

test("listRepos: returns empty array when cache dir is missing", () => {
  const old = process.env.REVIEWLORE_CACHE_DIR;
  process.env.REVIEWLORE_CACHE_DIR = "/nonexistent/path/that/does/not/exist";
  try {
    assert.deepEqual(listRepos(), []);
  } finally {
    if (old !== undefined) process.env.REVIEWLORE_CACHE_DIR = old;
    else delete process.env.REVIEWLORE_CACHE_DIR;
  }
});

test("searchRules: returns hint when no cache for repo", () => {
  return withTmpCache(async () => {
    const r = await searchRules({ owner: "missing", repo: "missing" });
    assert.match(r.hint, /No review history for missing\/missing yet/);
    assert.deepEqual(r.rules, []);
  });
});

test("searchRules: returns clusters meeting min thresholds", () => {
  return withTmpCache(async () => {
    mergeIntoCache("x", "y", baseCorpus());
    const r = await searchRules({ owner: "x", repo: "y" });
    assert.ok(r.rules.length >= 1, "should surface at least one rule");
    assert.ok(r.rules[0].occurrences >= 2);
  });
});

test("searchRules: topic filter narrows results", () => {
  return withTmpCache(async () => {
    mergeIntoCache("x", "y", baseCorpus());
    const all = await searchRules({ owner: "x", repo: "y" });
    const filtered = await searchRules({ owner: "x", repo: "y", topic: "nonexistent-keyword-xyz" });
    assert.ok(filtered.rules.length <= all.rules.length);
  });
});

test("recentFeedback: returns comments matching a path prefix", () => {
  return withTmpCache(async () => {
    mergeIntoCache("x", "y", baseCorpus());
    const r = await recentFeedback({ owner: "x", repo: "y", path: "src/api", months: 12 });
    assert.equal(r.comments.length, 2);
    assert.ok(r.comments.every((c) => c.path.startsWith("src/api")));
    // Most recent first
    assert.ok(new Date(r.comments[0].created_at) >= new Date(r.comments[1].created_at));
  });
});

test("recentFeedback: respects months cutoff", () => {
  return withTmpCache(async () => {
    mergeIntoCache("x", "y", baseCorpus());
    // baseCorpus comments are dated April 2026; today (per harness) is May 2026.
    // 1-month cutoff: comments from April should be included (within 1 month).
    // 0-month cutoff: nothing included.
    const r = await recentFeedback({ owner: "x", repo: "y", path: "src/api", months: 0 });
    assert.equal(r.comments.length, 0);
  });
});

// Regression: the server used to pass JSON-schema objects to McpServer.tool(),
// which only accepts Zod shapes, so it crashed on startup and the --help-only
// smoke test never noticed. Drive the real server over stdio instead.
test("reviewlore mcp starts, lists tools and answers a call over stdio", async () => {
  const { spawn } = await import("node:child_process");
  const { resolve } = await import("node:path");
  const bin = resolve(import.meta.dirname, "..", "cli", "reviewlore.mjs");
  // Empty temp cache dir: the server must never read the developer's real one.
  const dir = mkdtempSync(join(tmpdir(), "mcp-stdio-"));
  const child = spawn("node", [bin, "mcp"], { env: { ...process.env, REVIEWLORE_CACHE_DIR: dir }, stdio: ["pipe", "pipe", "pipe"] });
  const responses = new Map();
  let buf = "";
  child.stdout.on("data", (d) => {
    buf += d;
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const msg = JSON.parse(buf.slice(0, nl));
      buf = buf.slice(nl + 1);
      if (msg.id != null) responses.set(msg.id, msg);
    }
  });
  const send = (m) => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\n");
  const waitFor = async (id) => {
    for (let i = 0; i < 100 && !responses.has(id); i++) await new Promise((r) => setTimeout(r, 50));
    return responses.get(id);
  };
  try {
    send({ id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } } });
    assert.equal((await waitFor(1))?.result?.serverInfo?.name, "reviewlore");
    send({ method: "notifications/initialized" });
    send({ id: 2, method: "tools/list" });
    const names = (await waitFor(2)).result.tools.map((t) => t.name).sort();
    assert.deepEqual(names, ["list_repos", "recent_feedback", "review_feedback_for_path", "search_review_feedback", "search_rules"]);
    const forPath = (await waitFor(2)).result.tools.find((t) => t.name === "review_feedback_for_path");
    assert.equal(forPath._meta["anthropic/alwaysLoad"], true);
    assert.match((await waitFor(1)).result.instructions, /^Pull-request review history/);
    send({ id: 3, method: "tools/call", params: { name: "list_repos", arguments: {} } });
    const call = await waitFor(3);
    assert.equal(call.result.isError, undefined);
    assert.deepEqual(JSON.parse(call.result.content[0].text), []);
  } finally {
    child.kill();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("validateArgs enforces required keys, types and safe owner/repo names", async () => {
  const { TOOLS, validateArgs } = await import("../lib/mcp-tools.mjs");
  const search = TOOLS.find((t) => t.name === "search_rules");
  const recent = TOOLS.find((t) => t.name === "recent_feedback");
  assert.match(validateArgs(recent, {}), /Missing required argument "path"/);
  assert.equal(validateArgs(search, {}), null, "owner/repo are optional");
  assert.match(validateArgs(search, { owner: "o" }), /both owner and repo/);
  assert.match(validateArgs(search, { owner: "../..", repo: "x" }), /not a valid GitHub name/);
  assert.match(validateArgs(search, { owner: "o", repo: "r", limit: "5" }), /must be a number/);
  assert.match(validateArgs(search, { owner: "o", repo: "r", nope: 1 }), /Unknown argument/);
  assert.equal(validateArgs(search, { owner: "my-org", repo: "my_repo.js", limit: 3 }), null);
});

test("listRepos splits on the first '__' and includes a committed corpus", async () => {
  const { writeFileSync, mkdirSync } = await import("node:fs");
  return withTmpCache(async (dir) => {
    writeFileSync(join(dir, "org__repo__with__underscores.json"), "{}");
    const cwd = mkdtempSync(join(tmpdir(), "mcp-cwd-"));
    try {
      writeFileSync(join(cwd, ".reviewlore-corpus.json"), JSON.stringify({ meta: { owner: "team", repo: "app" } }));
      const repos = listRepos(cwd);
      assert.deepEqual(repos[0], { owner: "org", repo: "repo__with__underscores" });
      assert.deepEqual(repos[1], { owner: "team", repo: "app", source: "committed corpus", default: true });
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

test("searchRules: topic matches whole tokens, not substrings of stopwords", () => {
  return withTmpCache(async () => {
    mergeIntoCache("x", "y", baseCorpus());
    const count = async (topic) => ((await searchRules({ owner: "x", repo: "y", topic }))).rules.length;
    assert.ok((await count("types")) >= 1, "whole word (plural folded) matches");
    assert.equal(await count("ty"), 0, "a fragment of a word must not match");
    assert.equal(await count("a the"), 0, "stopword-only topics match nothing");
  });
});

test("projectDir: plugin-provided dir wins, unsubstituted values are ignored, git root is used", async () => {
  const { projectDir } = await import("../lib/mcp-tools.mjs");
  const { spawnSync } = await import("node:child_process");
  const { mkdirSync, realpathSync } = await import("node:fs");
  const repo = realpathSync.native(mkdtempSync(join(tmpdir(), "mcp-proj-")));
  try {
    spawnSync("git", ["init", "-q", repo]);
    const sub = join(repo, "packages", "a");
    mkdirSync(sub, { recursive: true });
    const other = realpathSync.native(tmpdir());
    assert.equal(projectDir({ REVIEWLORE_PROJECT_DIR: sub, CLAUDE_PROJECT_DIR: other }, other), repo);
    assert.equal(projectDir({ REVIEWLORE_PROJECT_DIR: "${CLAUDE_PROJECT_DIR}", CLAUDE_PROJECT_DIR: sub }, other), repo);
    assert.equal(projectDir({}, sub), repo);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
