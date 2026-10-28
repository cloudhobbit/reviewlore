import { test } from "node:test";
import assert from "node:assert/strict";
import { retryDecision, installRetry, RateLimitError } from "../lib/rate-limit.mjs";
import { createProgress, estimateRemaining, formatDuration } from "../lib/progress.mjs";

const NOW = Date.parse("2026-10-27T14:00:00Z");
const httpError = (status, headers = {}, message = "") => Object.assign(new Error(message), { status, response: { headers } });

test("retry-after is honoured, up to three attempts and the max wait", () => {
  const err = httpError(403, { "retry-after": "30" }, "You have exceeded a secondary rate limit");
  assert.deepEqual(retryDecision(err, 0, { now: NOW }), { retry: true, waitMs: 30_000, reason: "secondary rate limit" });
  assert.equal(retryDecision(err, 3, { now: NOW }).retry, false);
  const long = retryDecision(httpError(429, { "retry-after": "600" }), 0, { now: NOW, maxWaitMs: 60_000 });
  assert.equal(long.retry, false);
  assert.ok(long.error instanceof RateLimitError);
});

test("an exhausted primary limit waits for the reset only if it's soon", () => {
  const soon = httpError(403, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String((NOW + 20_000) / 1000) });
  const d = retryDecision(soon, 0, { now: NOW });
  assert.equal(d.retry, true);
  assert.equal(d.waitMs, 21_000);

  const later = httpError(403, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String((NOW + 3_600_000) / 1000) });
  const stop = retryDecision(later, 0, { now: NOW });
  assert.equal(stop.retry, false);
  assert.match(stop.error.message, /resets at 15:00 UTC\. Re-run then\./);
});

test("secondary limits without headers back off from 60 s; other 403s aren't retried", () => {
  const err = httpError(403, {}, "You have exceeded a secondary rate limit");
  assert.equal(retryDecision(err, 0, { now: NOW, maxWaitMs: 300_000 }).waitMs, 60_000);
  assert.equal(retryDecision(err, 1, { now: NOW, maxWaitMs: 300_000 }).waitMs, 120_000);
  assert.equal(retryDecision(err, 1, { now: NOW, maxWaitMs: 60_000 }).retry, false);
  assert.deepEqual(retryDecision(httpError(403, {}, "Resource not accessible by integration"), 0), { retry: false });
  assert.deepEqual(retryDecision(httpError(404), 0), { retry: false });
});

test("502/504 are retried twice", () => {
  assert.equal(retryDecision(httpError(502), 0).retry, true);
  assert.equal(retryDecision(httpError(504), 1).retry, true);
  assert.equal(retryDecision(httpError(502), 2).retry, false);
});

test("installRetry retries through the request hook, counts requests and never leaks headers", async () => {
  let wrapped;
  const octokit = { hook: { wrap: (name, fn) => { assert.equal(name, "request"); wrapped = fn; } } };
  const waits = [];
  const stats = installRetry(octokit, { sleep: async (ms) => waits.push(ms), now: () => NOW, onWait: () => {} });
  let n = 0;
  const request = async () => {
    n++;
    if (n === 1) throw httpError(403, { "retry-after": "2", authorization: "token ghp_xxx" }, "secondary rate limit");
    return { status: 200 };
  };
  assert.deepEqual(await wrapped(request, {}), { status: 200 });
  assert.deepEqual(waits, [2000]);
  assert.equal(stats.requests, 2);

  const failing = async () => { throw httpError(403, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String((NOW + 7_200_000) / 1000), authorization: "token ghp_xxx" }); };
  await assert.rejects(wrapped(failing, { headers: { authorization: "token ghp_xxx" } }), (e) => {
    assert.ok(e instanceof RateLimitError);
    assert.doesNotMatch(e.message, /ghp_|authorization/i);
    return true;
  });
});

test("progress: throttled lines off a TTY, ETA from overall progress", () => {
  let t = 0;
  const lines = [];
  const out = { write: (s) => lines.push(s) };
  const p = createProgress({ out, tty: false, now: () => t, intervalMs: 5000 });
  p.update({ stream: "reviews", fraction: 0.1 });
  t = 1000;
  p.update({ stream: "reviews", fraction: 0.2 }); // within 5 s: not printed
  t = 6000;
  p.stats.requests = 12;
  p.update({ stream: "comments", fraction: 0.4 });
  t = 9000;
  p.finish();
  assert.equal(lines.length, 3);
  assert.match(lines[1], /^Fetching: reviews 20% · comments 40% · inline 0% · 12 requests · ~\d+ s left\n$/);
  assert.match(lines[2], /^Fetched in 9 s · 12 GitHub requests\.\n$/);
  const timed = [];
  let u = 0;
  const q = createProgress({ out: { write: (x) => timed.push(x) }, tty: false, now: () => u });
  for (const [stream, at] of [["inline", 30_000], ["comments", 75_000], ["reviews", 200_000]]) {
    u = at;
    q.update({ stream, fraction: 1 });
  }
  q.finish();
  assert.match(timed.at(-1), /^Fetched in 3 min \(reviews 3 min, comments 75 s, inline 30 s\) · 0 GitHub requests\.\n$/);
});

test("estimateRemaining and formatDuration", () => {
  assert.equal(estimateRemaining(1000, 0.5), null, "too early to say");
  assert.equal(estimateRemaining(10_000, 0.5), 10_000);
  assert.equal(estimateRemaining(10_000, 1), 0);
  assert.equal(formatDuration(41_000), "41 s");
  assert.equal(formatDuration(300_000), "5 min");
});

test("real Octokit: REST and GraphQL calls both go through the retry hook", async () => {
  const { Octokit } = await import("@octokit/rest");
  const seen = [];
  let failNext = 2;
  const fetch = async (url) => {
    seen.push(String(url));
    if (failNext-- > 0) {
      return new Response(JSON.stringify({ message: "You have exceeded a secondary rate limit" }), {
        status: 403, headers: { "content-type": "application/json", "retry-after": "1" },
      });
    }
    const body = String(url).endsWith("/graphql") ? { data: { viewer: { login: "x" } } } : { id: 1 };
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  };
  const octokit = new Octokit({ auth: "ghp_xxx", request: { fetch } });
  const waits = [];
  const stats = installRetry(octokit, { sleep: async (ms) => waits.push(ms) });
  assert.deepEqual(await octokit.graphql("query { viewer { login } }"), { viewer: { login: "x" } });
  assert.equal((await octokit.request("GET /repos/{owner}/{repo}", { owner: "o", repo: "r" })).data.id, 1);
  // Two 403s on the GraphQL call, then success; the REST call goes straight through.
  assert.deepEqual(waits, [1000, 1000]);
  assert.equal(stats.requests, 4);
  assert.ok(seen.some((u) => u.endsWith("/graphql")));
});
