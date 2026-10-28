import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, realpathSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname, delimiter } from "node:path";
import { spawnSync } from "node:child_process";
import { mapDiscussions, createGitLabTransport, fetchGitLab, fetchGitLabCorpus, resolveGitLabToken, noGitLabTokenMessage } from "../lib/providers/gitlab.mjs";
import { extractCandidates } from "../lib/extract.mjs";
import { buildOutput } from "../lib/output.mjs";
import { rawComments } from "../lib/raw.mjs";
import { gitOnlyDir } from "./helpers/git-only.mjs";

const SINCE = new Date("2026-08-01T00:00:00Z");
const MR = (iid, updated = "2026-09-10T00:00:00Z", author = "mr-author") => ({ iid, title: `MR ${iid}`, updated_at: updated, author: { username: author }, web_url: `https://gitlab.com/group/sub/proj/-/merge_requests/${iid}` });
const note = (id, username, body, extra = {}) => ({ id, body, author: { username }, created_at: "2026-09-05T00:00:00Z", system: false, ...extra });

const DISCUSSIONS = {
  7: [
    { id: "a", individual_note: true, notes: [note(1, "alice", "Please add a changeset for this change.")] },
    { id: "b", individual_note: true, notes: [note(2, "alice", "added 1 commit", { system: true })] },
    { id: "c", individual_note: false, notes: [
      note(3, "bob", "Please avoid the any type in this handler.", { type: "DiffNote", position: { new_path: "src/api.ts", new_line: 12 }, resolvable: true, resolved: false }),
      note(4, "mr-author", "Done", { type: "DiffNote", resolvable: true }),
    ] },
    { id: "d", individual_note: true, notes: [note(5, "project_42_bot_3f2a", "Pipeline passed for this merge request.")] },
    { id: "e", individual_note: true, notes: [note(6, "carol", "Old comment.", { created_at: "2026-07-01T00:00:00Z" })] },
  ],
  8: [{ id: "f", individual_note: true, notes: [note(9, "dave", "This needs a changeset since it changes the CLI.")] }],
};

test("GitLab discussions map onto the corpus shape", () => {
  const { issue, review } = mapDiscussions(MR(7), DISCUSSIONS[7], SINCE);
  assert.deepEqual(issue.map((c) => [c.comment_id, c.author, c.author_type]), [[1, "alice", "User"], [5, "project_42_bot_3f2a", "Bot"]]);
  assert.equal(issue[0].html_url, "https://gitlab.com/group/sub/proj/-/merge_requests/7#note_1");
  assert.equal(issue[0].pr_number, 7);
  assert.deepEqual(review.map((c) => [c.comment_id, c.path, c.line, c.in_reply_to_id]), [[3, "src/api.ts", 12, null], [4, "src/api.ts", 12, 3]]);
  assert.equal(review[0].resolved, false);
  assert.ok(![...issue, ...review].some((c) => c.comment_id === 2 || c.comment_id === 6), "system note and pre-window note dropped");
});

// A fake fetch serving GitLab's REST shapes, 2 MRs per page, with one 429.
function fakeFetch() {
  const calls = [];
  let limited = false;
  const fn = async (url, init) => {
    calls.push({ url: String(url), auth: init.headers.Authorization });
    const u = new URL(url);
    const json = (body, headers = {}) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json", ...headers } });
    if (!limited) {
      limited = true;
      return new Response(JSON.stringify({ message: "429 Too Many Requests" }), { status: 429, headers: { "retry-after": "1" } });
    }
    if (u.pathname === "/api/v4/projects/group%2Fsub%2Fproj/merge_requests") {
      const page = Number(u.searchParams.get("page"));
      const all = [MR(8, "2026-09-12T00:00:00Z"), MR(7), MR(3, "2026-06-01T00:00:00Z")];
      return json(all.slice((page - 1) * 2, page * 2), { "x-next-page": page < 2 ? String(page + 1) : "" });
    }
    const m = u.pathname.match(/merge_requests\/(\d+)\/discussions$/);
    if (m) return json(DISCUSSIONS[m[1]] ?? []);
    return new Response(JSON.stringify({ message: "404 Project Not Found" }), { status: 404 });
  };
  return { fn, calls };
}

test("GitLab transport: token header, pagination, 429 retry; fetchGitLab end to end", async () => {
  const { fn, calls } = fakeFetch();
  const waits = [];
  const transport = createGitLabTransport({ host: "gitlab.com", token: "glpat-xxx", fetchImpl: fn, sleep: async (ms) => waits.push(ms) });
  const out = await fetchGitLab(transport, { repoPath: "group/sub/proj", since: SINCE });
  assert.deepEqual(waits, [1000]);
  assert.ok(calls.every((c) => c.auth === "Bearer glpat-xxx"));
  assert.ok(calls.some((c) => c.url.includes("updated_after=2026-08-01")));
  assert.deepEqual(Object.keys(out.prAuthors).sort(), ["7", "8"], "MR 3 is older than the window");
  assert.equal(out.issueComments.length, 3);
  assert.equal(out.reviewComments.length, 2);
  // Downstream extraction works unchanged on the mapped data.
  const data = buildOutput({ owner: "group/sub", repo: "proj", host: "gitlab.com", since: SINCE, monthsBack: 6, ...out });
  assert.ok(extractCandidates(data).some((c) => /changeset/.test(c.sentence)));
  const raw = rawComments(data);
  assert.equal(raw.url_base, "https://gitlab.com/group/sub/proj/-/merge_requests/");
  assert.ok(raw.rows.every((r) => /^\d+#note_\d+$/.test(r.u)));
});

test("GitLab errors carry the status and GitLab's message, never the token", async () => {
  const fetchImpl = async () => new Response(JSON.stringify({ message: "401 Unauthorized" }), { status: 401 });
  const transport = createGitLabTransport({ host: "gitlab.com", token: "glpat-secret-value", fetchImpl });
  await assert.rejects(transport.getPage("/projects/x/merge_requests"), (e) => {
    assert.equal(e.status, 401);
    assert.doesNotMatch(e.message + JSON.stringify(e), /glpat-secret-value/);
    return true;
  });
  assert.equal(resolveGitLabToken({ env: { GITLAB_TOKEN: "a", GITLAB_ACCESS_TOKEN: "b" } }).token, "a");
  assert.equal(resolveGitLabToken({ env: { GITHUB_TOKEN: "gh" } }), null, "a GitHub token is never used for GitLab");
});

test("GitLab environment tokens go only to gitlab.com, GITLAB_HOST, or the CI job's own instance", () => {
  const env = { GITLAB_TOKEN: "env-token" };
  assert.equal(resolveGitLabToken({ host: "gitlab.com", env }).token, "env-token");
  // A checkout whose origin names some other GitLab-looking host doesn't get it…
  assert.equal(resolveGitLabToken({ host: "gitlab.evil.io", env }), null);
  assert.match(noGitLabTokenMessage("gitlab.acme.corp"), /GITLAB_HOST=gitlab\.acme\.corp/);
  // …unless the user named that host, or a GitLab CI job runs there.
  assert.equal(resolveGitLabToken({ host: "gitlab.acme.corp", env: { ...env, GITLAB_HOST: "https://gitlab.acme.corp/" } }).token, "env-token");
  assert.equal(resolveGitLabToken({ host: "git.acme.corp", env: { ...env, GITLAB_CI: "true", CI_SERVER_HOST: "git.acme.corp" } }).token, "env-token");
  assert.equal(resolveGitLabToken({ host: "git.acme.corp", env: { ...env, CI_SERVER_HOST: "git.acme.corp" } }), null, "CI_SERVER_HOST counts only inside GitLab CI");
  assert.equal(resolveGitLabToken({ host: "gitlab.evil.io", token: "flag", env }).token, "flag", "--token is the user's explicit choice");
});

test("a GitLab redirect to another host doesn't carry the token", async () => {
  const http = await import("node:http");
  const listen = (s) => new Promise((r) => s.listen(0, "127.0.0.1", () => r(s.address().port)));
  let seen = null;
  const other = http.createServer((req, res) => { seen = req.headers; res.setHeader("content-type", "application/json"); res.end("[]"); });
  const otherPort = await listen(other);
  // An SSO gateway or proxy in front of a self-managed GitLab.
  const gitlab = http.createServer((req, res) => { res.statusCode = 302; res.setHeader("location", `http://localhost:${otherPort}/login`); res.end(); });
  const port = await listen(gitlab);
  try {
    const transport = createGitLabTransport({ host: "x", token: "glpat-redirect-test", baseUrl: `http://127.0.0.1:${port}/api/v4` });
    await transport.getPage("/projects/g%2Fp/merge_requests");
    assert.ok(seen, "the redirect was followed");
    assert.doesNotMatch(JSON.stringify(seen), /glpat-redirect-test/);
  } finally {
    other.close();
    gitlab.close();
  }
});

test("a GitLab corpus is stamped with the time its fetch started", async () => {
  let t = Date.parse("2026-10-01T00:00:00Z");
  const now = () => (t += 60_000);
  const { fn } = fakeFetch();
  const transport = createGitLabTransport({ host: "gitlab.com", token: "glpat-xxx", fetchImpl: fn, sleep: async () => {} });
  const out = await fetchGitLabCorpus(transport, { owner: "group/sub", repo: "proj", host: "gitlab.com", since: SINCE, monthsBack: 6, out: { write() {}, isTTY: false }, now });
  assert.equal(out.meta.fetched_at, "2026-10-01T00:01:00.000Z");
});

test("CLI on a GitLab checkout: committed corpus without a token; clear message without one", () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "gitlab-cli-")));
  try {
    spawnSync("git", ["init", "-q", dir]);
    spawnSync("git", ["-C", dir, "remote", "add", "origin", "git@gitlab.com:group/sub/proj.git"]);
    const env = { PATH: [gitOnlyDir(dir), dirname(process.execPath)].join(delimiter), REVIEWLORE_CACHE_DIR: join(dir, ".cache"), GITHUB_TOKEN: "github-token", GITLAB_TOKEN: "" };
    const cli = (args) => spawnSync(process.execPath, [resolve(import.meta.dirname, "..", "cli", "reviewlore.mjs"), ...args], { cwd: dir, encoding: "utf-8", env });

    const noToken = cli(["run", "--dry-run", "--no-cache"]);
    assert.equal(noToken.status, 1);
    assert.match(noToken.stderr, /Detected group\/sub\/proj on gitlab\.com from git origin/);
    assert.match(noToken.stderr, /No token for gitlab\.com\. Set GITLAB_TOKEN/);

    const issue = [1, 2, 3].map((n) => ({ type: "issue_comment", comment_id: n, pr_number: n, author: `r${n}`, author_type: "User", body: "Please add a changeset for this change.", created_at: "2026-09-0" + n + "T00:00:00Z", html_url: `https://gitlab.com/group/sub/proj/-/merge_requests/${n}#note_${n}` }));
    writeFileSync(join(dir, ".reviewlore-corpus.json"), JSON.stringify({ meta: { owner: "group/sub", repo: "proj", host: "gitlab.com", provider: "gitlab", fetched_at: "2026-10-01T00:00:00Z", pr_authors: {} }, issue_comments: issue, review_comments: [], review_submissions: [] }));
    const ok = cli(["candidates", "--no-cache"]);
    assert.equal(ok.status, 0, ok.stderr);
    assert.equal(JSON.parse(ok.stdout).repo, "group/sub/proj");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cache keys encode nested GitLab namespaces; list_repos decodes them", async () => {
  const { cachePath } = await import("../lib/cache.mjs");
  const dir = mkdtempSync(join(tmpdir(), "gitlab-cache-"));
  const before = process.env.REVIEWLORE_CACHE_DIR;
  process.env.REVIEWLORE_CACHE_DIR = dir;
  try {
    const path = cachePath("group/sub", "proj", "gitlab.com");
    assert.equal(path, join(dir, "hosts", "gitlab.com", "group+sub__proj.json"));
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "{}");
    const { listRepos } = await import("../lib/mcp-tools.mjs");
    assert.ok(listRepos(dir).some((r) => r.owner === "group/sub" && r.repo === "proj" && r.host === "gitlab.com"));
  } finally {
    if (before === undefined) delete process.env.REVIEWLORE_CACHE_DIR;
    else process.env.REVIEWLORE_CACHE_DIR = before;
    rmSync(dir, { recursive: true, force: true });
  }
});
