import { test } from "node:test";
import assert from "node:assert/strict";
import { applySignals, defaultWeightForState, timeDecayWeight } from "../lib/signals.mjs";

test("defaultWeightForState: CHANGES_REQUESTED > COMMENTED > APPROVED", () => {
  assert.ok(defaultWeightForState("CHANGES_REQUESTED") > defaultWeightForState("COMMENTED"));
  assert.ok(defaultWeightForState("COMMENTED") > defaultWeightForState("APPROVED"));
  assert.equal(defaultWeightForState("UNKNOWN"), 1.0);
});

test("applySignals drops PR-author self-comments", () => {
  const data = {
    meta: { pr_authors: { 1: "alice" } },
    issue_comments: [
      { author: "alice", pr_number: 1, body: "I implemented this because..." },
      { author: "bob",   pr_number: 1, body: "Please add tests." },
    ],
    review_comments: [],
    review_submissions: [],
  };
  const out = applySignals(data);
  assert.equal(out.issue_comments.length, 1);
  assert.equal(out.issue_comments[0].author, "bob");
  assert.equal(out._signalStats.droppedSelfComments, 1);
});

test("applySignals drops resolved threads where PR author concedes", () => {
  const data = {
    meta: { pr_authors: { 7: "author-pat" } },
    issue_comments: [],
    review_comments: [
      { comment_id: 10, in_reply_to_id: null, pr_number: 7,
        author: "reviewer-rae", body: "Avoid any types here.",
        created_at: "2026-01-01T00:00:00Z" },
      { comment_id: 11, in_reply_to_id: 10, pr_number: 7,
        author: "author-pat", body: "Good catch, fixed in next commit.",
        created_at: "2026-01-02T00:00:00Z" },
    ],
    review_submissions: [],
  };
  const out = applySignals(data);
  assert.equal(out.review_comments.length, 0);
  assert.equal(out._signalStats.droppedResolvedItems, 2);
});

test("applySignals drops threads where reviewer rescinds", () => {
  const data = {
    meta: { pr_authors: { 7: "author-pat" } },
    issue_comments: [],
    review_comments: [
      { comment_id: 20, in_reply_to_id: null, pr_number: 7,
        author: "reviewer-rae", body: "This looks wrong.",
        created_at: "2026-01-01T00:00:00Z" },
      { comment_id: 21, in_reply_to_id: 20, pr_number: 7,
        author: "reviewer-rae", body: "Nevermind, I see now.",
        created_at: "2026-01-02T00:00:00Z" },
    ],
    review_submissions: [],
  };
  const out = applySignals(data);
  assert.equal(out.review_comments.length, 0);
});

test("applySignals keeps the reviewer's comment in an unresolved thread", () => {
  // Author replies in disagreement — their reply is still a self-comment
  // and gets dropped by step 2, but the reviewer's original objection
  // must survive (thread is not resolved).
  const data = {
    meta: { pr_authors: { 7: "author-pat" } },
    issue_comments: [],
    review_comments: [
      { comment_id: 30, in_reply_to_id: null, pr_number: 7,
        author: "reviewer-rae", body: "Avoid any types.",
        created_at: "2026-01-01T00:00:00Z" },
      { comment_id: 31, in_reply_to_id: 30, pr_number: 7,
        author: "author-pat", body: "I disagree, here's why...",
        created_at: "2026-01-02T00:00:00Z" },
    ],
    review_submissions: [],
  };
  const out = applySignals(data);
  assert.equal(out.review_comments.length, 1);
  assert.equal(out.review_comments[0].author, "reviewer-rae");
});

test("applySignals weights CHANGES_REQUESTED submissions higher", () => {
  const data = {
    meta: { pr_authors: {} },
    issue_comments: [],
    review_comments: [],
    review_submissions: [
      { author: "a", state: "CHANGES_REQUESTED", body: "block" },
      { author: "b", state: "APPROVED", body: "ok" },
      { author: "c", state: "COMMENTED", body: "nit" },
    ],
  };
  const out = applySignals(data);
  const weights = Object.fromEntries(out.review_submissions.map((r) => [r.state, r.weight]));
  assert.equal(weights.CHANGES_REQUESTED, 2.0);
  assert.equal(weights.APPROVED, 0.5);
  assert.equal(weights.COMMENTED, 1.0);
});

test("timeDecayWeight: today=1.0; one half-life ago ≈ 0.5", () => {
  const now = new Date("2026-06-01T00:00:00Z");
  assert.equal(timeDecayWeight(now.toISOString(), now, 6), 1);
  const sixMonthsAgo = new Date("2025-12-01T00:00:00Z").toISOString();
  const w = timeDecayWeight(sixMonthsAgo, now, 6);
  assert.ok(Math.abs(w - 0.5) < 0.05, `expected ~0.5, got ${w}`);
});

test("timeDecayWeight: missing date returns 1.0 (no penalty)", () => {
  assert.equal(timeDecayWeight(null), 1.0);
  assert.equal(timeDecayWeight(undefined), 1.0);
});

test("applySignals time-decay is opt-in (default off)", () => {
  const data = {
    meta: { pr_authors: {} },
    issue_comments: [
      { author: "a", pr_number: 1, body: "Please add tests for null inputs.",
        created_at: "2025-01-01T00:00:00Z" },
    ],
    review_comments: [], review_submissions: [],
  };
  const out = applySignals(data, { now: new Date("2026-06-01T00:00:00Z") });
  // Without halfLifeMonths set, weight is just state-weight (1.0 for COMMENTED).
  assert.equal(out.issue_comments[0].weight, 1.0);
});

test("applySignals time-decay shrinks weight when enabled", () => {
  const data = {
    meta: { pr_authors: {} },
    issue_comments: [
      { author: "a", pr_number: 1, body: "Please add tests for null inputs.",
        created_at: "2025-01-01T00:00:00Z" },
    ],
    review_comments: [], review_submissions: [],
  };
  const out = applySignals(data, {
    now: new Date("2026-06-01T00:00:00Z"),
    timeDecayHalfLifeMonths: 6,
  });
  // 17 months ago at 6-month half-life ≈ 0.5^(17/6) ≈ 0.14.
  assert.ok(out.issue_comments[0].weight < 0.2);
});

test("applySignals can be disabled per-filter via opts", () => {
  const data = {
    meta: { pr_authors: { 1: "alice" } },
    issue_comments: [{ author: "alice", pr_number: 1, body: "self comment" }],
    review_comments: [],
    review_submissions: [],
  };
  const out = applySignals(data, { dropPrAuthorSelfComments: false });
  assert.equal(out.issue_comments.length, 1);
});
test("applySignals keeps reviewer feedback in PR-author-rooted threads ending with 'nevermind'", () => {
  // Regression: when the PR author opens a thread to self-annotate, then a
  // reviewer chimes in with real guidance, then the PR author closes with
  // 'nevermind', the reviewer's middle comment must survive. Previously the
  // resolved-by-reviewer rule fired because root.author === last.author
  // (both = PR author), dropping the whole thread.
  const data = {
    meta: { pr_authors: { 7: "author-pat" } },
    issue_comments: [],
    review_comments: [
      { comment_id: 40, in_reply_to_id: null, pr_number: 7,
        author: "author-pat", body: "Heads up: this branch handles the edge case.",
        created_at: "2026-01-01T00:00:00Z" },
      { comment_id: 41, in_reply_to_id: 40, pr_number: 7,
        author: "reviewer-rae", body: "You should extract this into a helper.",
        created_at: "2026-01-02T00:00:00Z" },
      { comment_id: 42, in_reply_to_id: 40, pr_number: 7,
        author: "author-pat", body: "nevermind, outdated now",
        created_at: "2026-01-03T00:00:00Z" },
    ],
    review_submissions: [],
  };
  const out = applySignals(data);
  // The reviewer's middle comment must survive; both PR-author comments
  // get dropped by the self-comment filter in step 2.
  assert.equal(out.review_comments.length, 1);
  assert.equal(out.review_comments[0].author, "reviewer-rae");
  assert.match(out.review_comments[0].body, /extract this into a helper/);
});

test("applySignals drops plain-issue comments from older corpora", () => {
  const data = {
    meta: { pr_authors: {} },
    issue_comments: [
      { comment_id: 1, pr_number: 1, author: "a", body: "x", html_url: "https://github.com/o/r/pull/1#issuecomment-1" },
      { comment_id: 2, pr_number: 2, author: "b", body: "y", html_url: "https://github.com/o/r/issues/2#issuecomment-2" },
    ],
    review_comments: [],
    review_submissions: [],
  };
  const out = applySignals(data);
  assert.deepEqual(out.issue_comments.map((c) => c.comment_id), [1]);
  assert.equal(out._signalStats.droppedIssueComments, 1);
});

test("an inline comment takes the state weight of the review it was posted in", () => {
  const data = {
    meta: { pr_authors: {} },
    issue_comments: [],
    review_submissions: [{ type: "review_submission", review_id: 77, pr_number: 1, author: "bob", state: "CHANGES_REQUESTED", body: "See inline", submitted_at: "2026-01-01T00:00:00Z" }],
    review_comments: [
      { type: "review_comment", comment_id: 1, pr_number: 1, author: "bob", body: "Please avoid this.", pull_request_review_id: 77, created_at: "2026-01-01T00:00:00Z" },
      { type: "review_comment", comment_id: 2, pr_number: 1, author: "bob", body: "Please avoid that.", created_at: "2026-01-01T00:00:00Z" },
    ],
  };
  const out = applySignals(data);
  const w = Object.fromEntries(out.review_comments.map((c) => [c.comment_id, c.weight]));
  assert.equal(w[1], 2, "inside a CHANGES_REQUESTED review");
  assert.equal(w[2], 1, "older corpora without the field: unchanged");
});
