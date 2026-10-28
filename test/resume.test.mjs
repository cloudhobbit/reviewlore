import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fetchCorpus, PartialFetch } from "../lib/fetchers.mjs";
import { partialPath, loadPartial } from "../lib/cache.mjs";
import { fakeGraphQL } from "./helpers/fake-graphql.mjs";

const T0 = Date.parse("2026-06-01T00:00:00Z");
const SINCE = new Date("2026-01-01T00:00:00Z");
const day = (n) => new Date(SINCE.getTime() + n * 86_400_000).toISOString();

// 250 issue comments and 180 inline comments (updated one per ~half day),
// 120 PRs with two reviews each. Every request moves the fake clock 1 s.
function makeRepo({ issueCount = 250 } = {}) {
  const step = 125 / issueCount; // spread over the same ~four months
  const issues = Array.from({ length: issueCount }, (_, i) => ({
    id: i + 1, issue_url: `https://api.github.com/repos/o/r/issues/${i % 120 + 1}`,
    user: { login: `u${i % 5}`, type: "User" }, body: `issue ${i}`,
    created_at: day(i * step), updated_at: day(i * step),
    html_url: `https://github.com/o/r/pull/${i % 120 + 1}#issuecomment-${i + 1}`,
  }));
  const inline = Array.from({ length: 180 }, (_, i) => ({
    id: 10_000 + i, pull_request_url: `https://api.github.com/repos/o/r/pulls/${i % 120 + 1}`,
    user: { login: `u${i % 4}`, type: "User" }, body: `inline ${i}`, path: "src/a.ts", line: 1, diff_hunk: "@@",
    created_at: day(i * 0.6), updated_at: day(i * 0.6), html_url: `https://github.com/o/r/pull/1#discussion_r${10_000 + i}`,
  }));
  const prs = Array.from({ length: 120 }, (_, i) => ({
    number: 120 - i, title: `PR ${120 - i}`, updatedAt: day(140 - i), author: { login: `a${i % 3}`, __typename: "User" },
    reviews: [0, 1].map((k) => ({
      id: 50_000 + i * 2 + k, url: `https://github.com/o/r/pull/${120 - i}#pullrequestreview-${50_000 + i * 2 + k}`,
      state: "COMMENTED", body: "r", submittedAt: day(139 - i), author: { login: `rv${k}`, __typename: "User" },
    })),
  }));
  return { issues, inline, prs };
}

// `maxPages` mimics GitHub's pagination depth limit: a listing simply ends
// (no rel="next") after that many pages.
function makeOctokit(data, clock, { failAfter, maxPages = Infinity } = {}) {
  const listings = { active: 0, max: 0 };
  let requests = 0;
  const tick = () => {
    clock.t += 1000;
    requests++;
    if (failAfter !== undefined && requests > failAfter) throw Object.assign(new Error("Server Error"), { status: 500 });
  };
  const pagesOf = (list, params) => {
    const from = Date.parse(params.since);
    const sorted = list.filter((c) => Date.parse(c.updated_at) >= from).sort((a, b) => a.updated_at.localeCompare(b.updated_at));
    return Array.from({ length: Math.ceil(sorted.length / 100) }, (_, p) => sorted.slice(p * 100, p * 100 + 100));
  };
  const listIssues = () => {};
  const listInline = () => {};
  const listPulls = () => {};
  const reviewCalls = { n: 0 };
  const listReviews = () => {};
  // REST review path: PR list (newest first) and one listReviews per PR.
  const paginate = async (method, params) => {
    tick();
    if (method === listPulls) {
      return data.prs.map((p) => ({ number: p.number, title: p.title, updated_at: p.updatedAt, user: { login: p.author.login } }));
    }
    reviewCalls.n++;
    const pr = data.prs.find((p) => p.number === params.pull_number);
    return pr.reviews.map((r) => ({ id: r.id, user: { login: r.author.login, type: "User" }, state: r.state, body: r.body, submitted_at: r.submittedAt, html_url: r.url }));
  };
  const graphqlFake = fakeGraphQL(data.prs, { onCall: () => tick() });
  return {
    reviewCalls,
    listings,
    hook: { wrap: () => {} },
    rest: { issues: { listCommentsForRepo: listIssues }, pulls: { listReviewCommentsForRepo: listInline, list: listPulls, listReviews } },
    paginate: Object.assign(paginate, { iterator: async function* (method, params) {
      listings.active++;
      listings.max = Math.max(listings.max, listings.active);
      try {
      const pages = pagesOf(method === listIssues ? data.issues : data.inline, params).slice(0, maxPages);
      if (!pages.length) {
        tick();
        yield { data: [], headers: {} };
      }
      for (let p = 0; p < pages.length; p++) {
        tick();
        await new Promise((r) => setImmediate(r)); // let other listings interleave
        yield { data: pages[p], headers: { link: p < pages.length - 1 ? '<https://api.github.com/x?page=2>; rel="next"' : "" } };
      }
      } finally {
        listings.active--;
      }
    } }),
    graphql: graphqlFake.graphql,
  };
}

const ids = (out) => ({
  issues: out.issue_comments.map((c) => c.comment_id).sort((a, b) => a - b),
  inline: out.review_comments.map((c) => c.comment_id).sort((a, b) => a - b),
  reviews: out.review_submissions.map((c) => c.review_id).sort((a, b) => a - b),
  prAuthors: out.meta.pr_authors,
});

function withCache(fn) {
  const dir = mkdtempSync(join(tmpdir(), "resume-cache-"));
  const before = process.env.REVIEWLORE_CACHE_DIR;
  process.env.REVIEWLORE_CACHE_DIR = dir;
  return Promise.resolve(fn(dir)).finally(() => {
    if (before === undefined) delete process.env.REVIEWLORE_CACHE_DIR;
    else process.env.REVIEWLORE_CACHE_DIR = before;
    rmSync(dir, { recursive: true, force: true });
  });
}

const opts = (clock, extra = {}) => ({ owner: "o", repo: "r", since: SINCE, monthsBack: 6, now: () => clock.t, ...extra });

test("a fetch stopped by its time budget resumes to the same result as an uninterrupted one", () => withCache(async () => {
  const data = makeRepo();
  const clockA = { t: T0 };
  const full = await fetchCorpus(makeOctokit(data, clockA), opts(clockA));

  const clock = { t: T0 };
  await assert.rejects(
    fetchCorpus(makeOctokit(data, clock), opts(clock, { checkpoint: true, budgetMs: 1500, concurrency: 1 })),
    (e) => e instanceof PartialFetch && /re-run the same command/.test(e.message),
  );
  assert.ok(existsSync(partialPath("o", "r")), "progress saved");
  const firstStart = new Date(T0).toISOString();

  let runs = 1;
  let out;
  for (;;) {
    runs++;
    try {
      out = await fetchCorpus(makeOctokit(data, clock), opts(clock, { checkpoint: true, budgetMs: 1500, concurrency: 1 }));
      break;
    } catch (e) {
      assert.ok(e instanceof PartialFetch, e.message);
      assert.ok(runs < 20, "never finished");
    }
  }
  assert.ok(runs > 2, "took several budgeted runs");
  assert.deepEqual(ids(out), ids(full));
  assert.equal(existsSync(partialPath("o", "r")), false, "partial deleted on success");
  assert.equal(out.meta.fetched_at, firstStart, "incremental cutoff is when the first run started");
}));

test("an upstream failure keeps the progress made so far", () => withCache(async () => {
  const data = makeRepo();
  const clock = { t: T0 };
  await assert.rejects(fetchCorpus(makeOctokit(data, clock, { failAfter: 4 }), opts(clock, { checkpoint: true })), /Server Error/);
  const saved = JSON.parse(readFileSync(partialPath("o", "r"), "utf-8"));
  const kept = saved.streams.comments.items.length + saved.streams.inline.items.length + saved.streams.reviews.items.length;
  assert.ok(kept > 0, "some pages were saved");
  const out = await fetchCorpus(makeOctokit(data, clock), opts(clock, { checkpoint: true }));
  const clockA = { t: T0 };
  assert.deepEqual(ids(out), ids(await fetchCorpus(makeOctokit(data, clockA), opts(clockA))));
}));

test("a partial for a shorter window, a stale one or a corrupt one isn't resumed", () => withCache(async () => {
  const partial = { version: 3, owner: "o", repo: "r", since: "2026-03-01T00:00:00Z", started_at: new Date(T0).toISOString(), streams: {} };
  writeFileSync(partialPath("o", "r"), JSON.stringify(partial));
  assert.equal(loadPartial("o", "r", SINCE, T0), null, "starts two months later than asked");
  assert.ok(loadPartial("o", "r", new Date("2026-03-01T06:00:00Z"), T0), "within a day: fine");
  assert.equal(loadPartial("o", "r", new Date("2026-03-01T00:00:00Z"), T0 + 8 * 86_400_000), null, "over a week old");
  writeFileSync(partialPath("o", "r"), "{ not json");
  assert.equal(loadPartial("o", "r", SINCE, T0), null);
}));

test("without checkpointing nothing is written to the cache directory", () => withCache(async (dir) => {
  const data = makeRepo();
  const clock = { t: T0 };
  await assert.rejects(fetchCorpus(makeOctokit(data, clock), opts(clock, { budgetMs: 1500 })), PartialFetch);
  assert.equal(existsSync(partialPath("o", "r")), false);
  assert.equal(existsSync(join(dir, "o__r.json")), false);
}));

test("a listing GitHub cuts off after a few pages is continued from the last update time", () => withCache(async () => {
  const data = makeRepo();
  const clockA = { t: T0 };
  const full = await fetchCorpus(makeOctokit(data, clockA), opts(clockA));
  const clock = { t: T0 };
  const capped = await fetchCorpus(makeOctokit(data, clock, { maxPages: 1 }), opts(clock));
  assert.deepEqual(ids(capped), ids(full));
}));

test("the REST review fallback resumes per PR instead of starting over", () => withCache(async () => {
  const data = makeRepo();
  const clockA = { t: T0 };
  const full = await fetchCorpus(makeOctokit(data, clockA), opts(clockA, { mode: "rest" }));
  const clock = { t: T0 };
  await assert.rejects(fetchCorpus(makeOctokit(data, clock), opts(clock, { mode: "rest", checkpoint: true, budgetMs: 20_000 })), PartialFetch);
  const saved = JSON.parse(readFileSync(partialPath("o", "r"), "utf-8")).streams.reviews;
  assert.ok(saved.restDone.length > 0 && saved.restDone.length < 120, `saved ${saved.restDone.length} PRs`);
  // The resumed run fetches only the remaining PRs' reviews (plus the PR list).
  const octokit = makeOctokit(data, clock);
  const out = await fetchCorpus(octokit, opts(clock, { mode: "rest", checkpoint: true }));
  assert.deepEqual(ids(out), ids(full));
  assert.equal(octokit.reviewCalls.n, 120 - saved.restDone.length);
}));

test("time slices: same result as one listing, never more than the pool size at once", () => withCache(async () => {
  const data = makeRepo({ issueCount: 2500 });
  const clockA = { t: T0 };
  const sequential = await fetchCorpus(makeOctokit(data, clockA), opts(clockA, { concurrency: 1 }));
  const clock = { t: T0 };
  const octokit = makeOctokit(data, clock);
  const sliced = await fetchCorpus(octokit, opts(clock, { concurrency: 3 }));
  assert.deepEqual(ids(sliced), ids(sequential));
  assert.equal(octokit.listings.max, 3, "pool of 3 shared by both comment listings");
  // Same data even when GitHub cuts every listing off after one page.
  const clockC = { t: T0 };
  assert.deepEqual(ids(await fetchCorpus(makeOctokit(data, clockC, { maxPages: 1 }), opts(clockC, { concurrency: 3 }))), ids(sequential));
}));

test("a budgeted sliced fetch resumes slice by slice to the same result", () => withCache(async () => {
  const data = makeRepo({ issueCount: 2500 });
  const clockA = { t: T0 };
  const full = await fetchCorpus(makeOctokit(data, clockA), opts(clockA, { concurrency: 1 }));
  const clock = { t: T0 };
  let runs = 0;
  let out;
  for (;;) {
    runs++;
    assert.ok(runs < 40, "never finished");
    try {
      out = await fetchCorpus(makeOctokit(data, clock), opts(clock, { checkpoint: true, budgetMs: 1500, concurrency: 4 }));
      break;
    } catch (e) {
      assert.ok(e instanceof PartialFetch, e.message);
    }
  }
  assert.ok(runs > 2, `took ${runs} runs`);
  assert.deepEqual(ids(out), ids(full));
}));

test("a resumed GraphQL review fetch only asks for the PRs not yet stored", () => withCache(async () => {
  const data = makeRepo();
  const clock = { t: T0 };
  const inWindow = data.prs.filter((p) => p.updatedAt >= SINCE.toISOString()).length;
  // Short budgeted runs until the PR list is done and some reviews are stored.
  let saved;
  for (let run = 0; run < 30; run++) {
    await assert.rejects(fetchCorpus(makeOctokit(data, clock), opts(clock, { checkpoint: true, budgetMs: 1500 })), PartialFetch);
    saved = JSON.parse(readFileSync(partialPath("o", "r"), "utf-8")).streams.reviews;
    if (saved.listed && saved.reviewed.length > 0) break;
  }
  assert.equal(saved.listed, true);
  assert.ok(saved.reviewed.length > 0 && saved.reviewed.length < inWindow, `stored ${saved.reviewed.length} of ${inWindow}`);
  const octokit = makeOctokit(data, clock);
  const asked = [];
  const graphql = octokit.graphql;
  octokit.graphql = (q, v) => {
    for (const [, n] of q.matchAll(/pullRequest\(number: (\d+)\)/g)) asked.push(Number(n));
    return graphql(q, v);
  };
  const out = await fetchCorpus(octokit, opts(clock, { checkpoint: true }));
  assert.equal(asked.length, inWindow - saved.reviewed.length);
  assert.ok(!asked.some((n) => saved.reviewed.includes(n)));
  const clockA = { t: T0 };
  assert.deepEqual(ids(out), ids(await fetchCorpus(makeOctokit(data, clockA), opts(clockA))));
}));
