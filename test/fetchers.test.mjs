import { test } from "node:test";
import assert from "node:assert/strict";
import {
  fetchIssueComments,
  fetchReviewComments,
  fetchReviewSubmissions,
  fetchReviewSubmissionsRest,
  fetchReviewSubmissionsGraphQL,
  fetchAll,
  windowFraction,
} from "../lib/fetchers.mjs";
import { fakeGraphQL, isBatch, isList } from "./helpers/fake-graphql.mjs";

// Octokit's paginate auto-pages. We don't need a real Octokit; we just
// need an object that exposes `paginate(method, params, callback?)` and
// `rest.*.*` placeholder methods. The lib code only references these by
// identity (it passes the method into paginate); our fake paginate ignores
// the method and returns canned data.

function makeFakeOctokit({ issues = [], pulls = [], reviewsByPr = {}, prList = [] } = {}) {
  const paginate = async (method, _params, callback) => {
      const data = method.__source;
      if (data === "issues") return issues;
      if (data === "pulls") return pulls;
      if (data === "prList") {
        // Honour the early-exit callback used by fetchReviewSubmissions.
        if (callback) callback({ data: prList }, () => {});
        return prList;
      }
      if (data === "reviews") {
        // _params.pull_number selects which PR's reviews to return.
        return reviewsByPr[_params.pull_number] ?? [];
      }
      return [];
  };
  // The comment streams page through iterator(); serve everything as one page.
  paginate.iterator = async function* (method, params) {
    yield { data: await paginate(method, params) };
  };
  return {
    paginate,
    rest: {
      issues: { listCommentsForRepo: tagged("issues") },
      pulls: {
        listReviewCommentsForRepo: tagged("pulls"),
        list: tagged("prList"),
        listReviews: tagged("reviews"),
      },
    },
  };
}
function tagged(src) {
  const fn = () => {};
  fn.__source = src;
  return fn;
}

const since = new Date("2025-11-01T00:00:00Z");
const inRange = "2025-12-15T12:00:00Z";
const outOfRange = "2025-10-01T12:00:00Z";

test("fetchIssueComments filters by created_at and shapes output", async () => {
  const oct = makeFakeOctokit({
    issues: [
      {
        id: 1, issue_url: "https://api.github.com/repos/x/y/issues/42",
        user: { login: "alice", type: "User" },
        body: "hello", created_at: inRange, updated_at: inRange,
        html_url: "u1",
      },
      {
        id: 2, issue_url: "https://api.github.com/repos/x/y/issues/43",
        user: { login: "bob", type: "User" },
        body: "old", created_at: outOfRange, updated_at: outOfRange,
        html_url: "u2",
      },
    ],
  });
  const r = await fetchIssueComments(oct, { owner: "x", repo: "y", since });
  assert.equal(r.length, 1);
  assert.equal(r[0].type, "issue_comment");
  assert.equal(r[0].pr_number, 42);
  assert.equal(r[0].author, "alice");
});

test("fetchReviewComments preserves path / line / diff_hunk", async () => {
  const oct = makeFakeOctokit({
    pulls: [
      {
        id: 100, pull_request_url: "https://api.github.com/repos/x/y/pulls/7",
        user: { login: "alice", type: "User" },
        body: "nit", path: "src/a.ts", line: 42, diff_hunk: "@@ ...",
        in_reply_to_id: null,
        created_at: inRange, updated_at: inRange,
        html_url: "u",
      },
    ],
  });
  const r = await fetchReviewComments(oct, { owner: "x", repo: "y", since });
  assert.equal(r.length, 1);
  assert.equal(r[0].path, "src/a.ts");
  assert.equal(r[0].line, 42);
  assert.equal(r[0].diff_hunk, "@@ ...");
});

test("fetchReviewSubmissions iterates each in-range PR and shapes reviews", async () => {
  const oct = makeFakeOctokit({
    prList: [
      { number: 1, title: "PR one", updated_at: inRange, user: { login: "owner-alice" } },
      { number: 2, title: "PR two", updated_at: inRange, user: { login: "owner-bob" } },
      { number: 99, title: "ancient", updated_at: outOfRange },
    ],
    reviewsByPr: {
      1: [{ id: 11, user: { login: "alice", type: "User" }, state: "APPROVED",
            body: "ok", submitted_at: inRange, html_url: "u" }],
      2: [{ id: 22, user: { login: "bob", type: "User" }, state: "CHANGES_REQUESTED",
            body: "needs work", submitted_at: inRange, html_url: "u" }],
    },
  });
  const r = await fetchReviewSubmissions(oct, { owner: "x", repo: "y", since });
  assert.equal(r.reviews.length, 2);
  assert.deepEqual(r.reviews.map((x) => x.pr_number).sort(), [1, 2]);
  assert.deepEqual(r.reviews.map((x) => x.state).sort(), ["APPROVED", "CHANGES_REQUESTED"]);
  // PR-author map populated for in-range PRs only.
  assert.equal(r.prAuthors[1], "owner-alice");
  assert.equal(r.prAuthors[2], "owner-bob");
  assert.equal(r.prAuthors[99], undefined);
});

test("fetchReviewSubmissions handles missing user gracefully", async () => {
  const oct = makeFakeOctokit({
    prList: [{ number: 1, title: "t", updated_at: inRange, user: { login: "owner" } }],
    reviewsByPr: { 1: [{ id: 11, user: null, state: "COMMENTED", body: "?",
                          submitted_at: inRange, html_url: "u" }] },
  });
  const r = await fetchReviewSubmissions(oct, { owner: "x", repo: "y", since });
  assert.equal(r.reviews[0].author, "unknown");
});

test("fetchIssueComments drops comments on plain issues (keeps PR conversation)", async () => {
  const oct = makeFakeOctokit({
    issues: [
      {
        id: 1, issue_url: "https://api.github.com/repos/x/y/issues/42",
        user: { login: "alice", type: "User" }, body: "Please add a test",
        created_at: inRange, updated_at: inRange,
        html_url: "https://github.com/x/y/pull/42#issuecomment-1",
      },
      {
        id: 2, issue_url: "https://api.github.com/repos/x/y/issues/43",
        user: { login: "bob", type: "User" }, body: "Could you assign this to me?",
        created_at: inRange, updated_at: inRange,
        html_url: "https://github.com/x/y/issues/43#issuecomment-2",
      },
    ],
  });
  const r = await fetchIssueComments(oct, { owner: "x", repo: "y", since });
  assert.deepEqual(r.map((c) => c.comment_id), [1]);
});

test("windowFraction measures progress through the window", () => {
  const now = Date.parse("2026-01-01T00:00:00Z");
  const from = new Date("2025-12-01T00:00:00Z");
  assert.equal(windowFraction("2025-12-16T12:00:00Z", from, now), 0.5);
  assert.equal(windowFraction("2025-12-16T12:00:00Z", from, now, { descending: true }), 0.5);
  assert.equal(windowFraction("2025-11-01T00:00:00Z", from, now), 0);
  assert.equal(windowFraction("2025-11-01T00:00:00Z", from, now, { descending: true }), 1);
});

// ---- GraphQL reviews --------------------------------------------------

function makeGraphQL(prs, { fail } = {}) {
  return fakeGraphQL(prs, { onCall: fail });
}

const user = (login) => ({ login, __typename: "User" });
const gqlReview = (id, author, extra = {}) => ({
  id, author, state: "COMMENTED", body: `review ${id}`, submittedAt: inRange,
  url: `https://github.com/x/y/pull/1#pullrequestreview-${id}`, ...extra,
});

test("GraphQL reviews: cursor loop stops at the first PR older than the window", async () => {
  const prs = Array.from({ length: 120 }, (_, i) => ({
    number: 200 - i, title: `PR ${i}`, updatedAt: i < 70 ? inRange : outOfRange,
    author: user(`author${i}`), reviews: [gqlReview(1000 + i, user("rev"))],
  }));
  const { graphql, calls } = makeGraphQL(prs);
  const r = await fetchReviewSubmissionsGraphQL({ graphql }, { owner: "x", repo: "y", since });
  assert.equal(calls.filter(isList).length, 1, "one list page of 100 reaches past the window");
  assert.equal(calls.filter(isBatch).length, 3, "70 PRs in batches of 25");
  assert.equal(Object.keys(r.prAuthors).length, 70);
  assert.equal(r.reviews.length, 70);
});

test("GraphQL reviews: more than 50 reviews on a PR triggers a follow-up query", async () => {
  const reviews = Array.from({ length: 57 }, (_, i) => gqlReview(i + 1, user(`r${i % 3}`)));
  const { graphql, calls } = makeGraphQL([{ number: 1, title: "big", updatedAt: inRange, author: user("o"), reviews }]);
  const r = await fetchReviewSubmissionsGraphQL({ graphql }, { owner: "x", repo: "y", since });
  assert.equal(r.reviews.length, 57);
  assert.equal(calls.filter((c) => c.vars.number === 1).length, 1, "one follow-up for reviews 51-57");
});

test("GraphQL reviews map to the REST record shape (parity)", async () => {
  const bot = { login: "renovate", __typename: "Bot" };
  const gql = makeGraphQL([{
    number: 1, title: "PR one", updatedAt: inRange, author: bot,
    reviews: [
      gqlReview(4123456789, user("alice"), { state: "CHANGES_REQUESTED", body: "needs work" }),
      gqlReview(11, null, { body: "" }),
      gqlReview(12, { login: "coderabbitai", __typename: "Bot" }),
      gqlReview(13, user("old"), { submittedAt: outOfRange }),
    ],
  }]);
  const rest = makeFakeOctokit({
    prList: [{ number: 1, title: "PR one", updated_at: inRange, user: { login: "renovate[bot]", type: "Bot" } }],
    reviewsByPr: {
      1: [
        { id: 4123456789, user: { login: "alice", type: "User" }, state: "CHANGES_REQUESTED", body: "needs work", submitted_at: inRange, html_url: "https://github.com/x/y/pull/1#pullrequestreview-4123456789" },
        { id: 11, user: null, state: "COMMENTED", body: "", submitted_at: inRange, html_url: "https://github.com/x/y/pull/1#pullrequestreview-11" },
        { id: 12, user: { login: "coderabbitai[bot]", type: "Bot" }, state: "COMMENTED", body: "review 12", submitted_at: inRange, html_url: "https://github.com/x/y/pull/1#pullrequestreview-12" },
        { id: 13, user: { login: "old", type: "User" }, state: "COMMENTED", body: "review 13", submitted_at: outOfRange, html_url: "https://github.com/x/y/pull/1#pullrequestreview-13" },
      ],
    },
  });
  const fromGql = await fetchReviewSubmissionsGraphQL({ graphql: gql.graphql }, { owner: "x", repo: "y", since });
  const fromRest = await fetchReviewSubmissionsRest(rest, { owner: "x", repo: "y", since });
  // REST reports a deleted user's type as "unknown" too.
  assert.deepEqual(fromGql, fromRest);
  assert.equal(fromGql.reviews[0].review_id, 4123456789);
  assert.equal(fromGql.prAuthors[1], "renovate[bot]");
});

test("GraphQL reviews fall back to databaseId on servers without fullDatabaseId", async () => {
  const { graphql, calls } = makeGraphQL(
    [{ number: 1, title: "t", updatedAt: inRange, author: user("o"), reviews: [gqlReview(5, user("a"))] }],
    { fail: (q) => { if (q.includes("fullDatabaseId")) throw new Error("Field 'fullDatabaseId' doesn't exist on type 'PullRequestReview'"); } },
  );
  const r = await fetchReviewSubmissionsGraphQL({ graphql }, { owner: "x", repo: "y", since });
  assert.equal(r.reviews[0].review_id, 5);
  assert.ok(calls.at(-1).query.includes("databaseId"));
});

test("fetchReviewSubmissions falls back to REST when GraphQL is forbidden, and reports why", async () => {
  const oct = makeFakeOctokit({
    prList: [{ number: 1, title: "t", updated_at: inRange, user: { login: "o" } }],
    reviewsByPr: { 1: [{ id: 1, user: { login: "a", type: "User" }, state: "COMMENTED", body: "x", submitted_at: inRange, html_url: "u" }] },
  });
  oct.graphql = async () => { throw Object.assign(new Error("Resource not accessible by integration"), { status: 403 }); };
  const notices = [];
  const r = await fetchReviewSubmissions(oct, { owner: "x", repo: "y", since, onNotice: (m) => notices.push(m) });
  assert.equal(r.reviews.length, 1);
  assert.match(notices[0], /REST instead/);

  oct.graphql = async () => { throw Object.assign(new Error("boom"), { status: 500 }); };
  await assert.rejects(fetchReviewSubmissions(oct, { owner: "x", repo: "y", since }), /boom/);
});

test("fetchAll reports progress for all three streams and reaches 100%", async () => {
  const oct = makeFakeOctokit({ prList: [{ number: 1, title: "t", updated_at: inRange, user: { login: "o" } }] });
  const last = {};
  const r = await fetchAll(oct, { owner: "x", repo: "y", since, onProgress: (e) => { last[e.stream] = e.fraction; } });
  assert.deepEqual(Object.keys(r).sort(), ["issueComments", "prAuthors", "reviewComments", "reviewSubmissions"]);
  assert.deepEqual(last, { comments: 1, inline: 1, reviews: 1 });
});

test("makeSlices: about a week each, at most 24, contiguous, last one open-ended", async () => {
  const { makeSlices } = await import("../lib/fetchers.mjs");
  const from = new Date("2026-04-27T00:00:00Z");
  const now = Date.parse("2026-10-27T00:00:00Z");
  const six = makeSlices(from, now);
  assert.equal(six.length, 24);
  assert.equal(six[0].from, from.toISOString());
  assert.equal(six.at(-1).to, null);
  for (let k = 1; k < six.length; k++) assert.equal(six[k].from, six[k - 1].to);
  assert.equal(makeSlices(new Date(now - 3 * 86_400_000), now).length, 1, "a short top-up is one listing");
  assert.equal(makeSlices(from, now, { concurrency: 1 }).length, 1);
});

test("fetchConcurrency reads REVIEWLORE_FETCH_CONCURRENCY", async () => {
  const { fetchConcurrency } = await import("../lib/fetchers.mjs");
  assert.equal(fetchConcurrency({}), 6);
  assert.equal(fetchConcurrency({ REVIEWLORE_FETCH_CONCURRENCY: "1" }), 1);
  assert.equal(fetchConcurrency({ REVIEWLORE_FETCH_CONCURRENCY: "lots" }), 6);
  assert.equal(fetchConcurrency({ REVIEWLORE_FETCH_CONCURRENCY: "500" }), 20);
});

test("GraphQL reviews: batches run in parallel (at most 4), deleted PRs are skipped", async () => {
  const prs = Array.from({ length: 200 }, (_, i) => ({
    number: 1000 - i, title: `PR ${i}`, updatedAt: inRange, author: user("o"), reviews: [gqlReview(5000 + i, user("rev"))],
  }));
  let active = 0;
  let max = 0;
  const { graphql, calls } = fakeGraphQL(prs, {
    onCall: async (query) => {
      if (!/p0: pullRequest/.test(query)) return;
      active++;
      max = Math.max(max, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
    },
  });
  // A PR that disappears after being listed comes back as null.
  const wrapped = async (q, v) => {
    const res = await graphql(q, v);
    if (res.repository?.p3) res.repository.p3 = null;
    return res;
  };
  const r = await fetchReviewSubmissionsGraphQL({ graphql: wrapped }, { owner: "x", repo: "y", since });
  assert.equal(max, 4);
  assert.equal(calls.filter(isBatch).length, 8, "200 PRs / 25");
  assert.equal(r.reviews.length, 200 - 8, "one skipped PR per batch");
  assert.equal(Object.keys(r.prAuthors).length, 200);
});
