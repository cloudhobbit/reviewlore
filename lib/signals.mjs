// Higher-signal filtering applied between fetch and extract. Four filters:
//
// 0. Plain-issue comments: corpora fetched before v0.3 include comments
//    on issues (bug reports, triage, "assign me"), which aren't PR review.
//    Drop them here so old caches and committed corpora are cleaned too.
// 1. PR-author self-comments: a PR author commenting on their own PR is
//    explaining their change, not reviewing it. Strip these.
// 2. Resolved review-comment threads: if a review thread (linked via
//    in_reply_to_id) ends with the PR author conceding (`fixed`, `done`,
//    `good catch`, `addressed`, `sgtm`, `nevermind`), the original
//    objection was accepted and the rule landed in code — we can drop
//    the thread because the rule is now in the codebase. If it ends with
//    the *reviewer* saying nevermind / outdated, we drop too (false alarm).
// 3. State weighting: each candidate gets a `weight` (≥1). Reviews with
//    `state=CHANGES_REQUESTED` count 2× (they blocked merge); plain
//    `COMMENTED` reviews count 1×; `APPROVED` reviews count 0.5× (they
//    cleared merge). An inline comment takes the state of the review it was
//    posted in, when the corpus records it (`pull_request_review_id`).
//    Used by extract/cluster when computing occurrences.

import { isPlainIssueComment } from "./filters.mjs";

export const RESOLVED_BY_AUTHOR_RE =
  /\b(fixed|done|good catch|good point|addressed|resolved|sgtm|will do)\b/i;
export const RESOLVED_BY_REVIEWER_RE =
  /\b(nevermind|never mind|disregard|outdated|n\/?m|my mistake|ignore (this|me))\b/i;

const STATE_WEIGHTS = {
  CHANGES_REQUESTED: 2.0,
  COMMENTED: 1.0,
  APPROVED: 0.5,
  DISMISSED: 0.25,
};

export function defaultWeightForState(state) {
  return STATE_WEIGHTS[state] ?? 1.0;
}

// Time-decay weight: a comment from N months ago gets multiplier 0.5^(N/halfLife).
// Default half-life is 6 months — a comment from a year ago counts ~1/4 of one
// from this week. Returns 1.0 if either input is missing (don't penalise
// unknown).
export function timeDecayWeight(createdAt, now = new Date(), halfLifeMonths = 6) {
  if (!createdAt || !halfLifeMonths) return 1.0;
  const ms = Math.max(0, now.getTime() - new Date(createdAt).getTime());
  const months = ms / (1000 * 60 * 60 * 24 * 30.4375);
  return Math.pow(0.5, months / halfLifeMonths);
}

// Returns a NEW data object with self-comments removed, resolved threads
// dropped, and a `weight` field added to every remaining comment.
//
// Order of operations matters: resolved-thread detection runs FIRST against
// the unfiltered review comments (otherwise the PR-author's "fixed!" reply
// gets dropped as a self-comment before it can be used as resolution
// evidence). Self-comment filtering then runs on what remains.
export function applySignals(data, opts = {}) {
  const prAuthors = data.meta?.pr_authors ?? {};
  const dropPrAuthor = opts.dropPrAuthorSelfComments ?? true;
  const dropResolved = opts.dropResolvedThreads ?? true;
  const weighByState = opts.weighByState ?? true;

  const stats = { droppedIssueComments: 0, droppedSelfComments: 0, droppedResolvedItems: 0 };

  const isPrAuthor = (c) =>
    c?.pr_number != null && c.author === prAuthors[c.pr_number];

  let issueComments = data.issue_comments ?? [];
  // ---- Step 0: comments on plain issues are not PR review ----
  const prOnly = issueComments.filter((c) => !isPlainIssueComment(c));
  stats.droppedIssueComments = issueComments.length - prOnly.length;
  issueComments = prOnly;
  let reviewComments = data.review_comments ?? [];
  let reviewSubmissions = data.review_submissions ?? [];

  // ---- Step 1: resolved review-comment threads (BEFORE self-comment filter) ----
  if (dropResolved) {
    const allRC = reviewComments;
    const byId = new Map(allRC.map((c) => [c.comment_id, c]));
    const rootOf = (c) => {
      let cur = c;
      const seen = new Set();
      while (cur?.in_reply_to_id != null && byId.has(cur.in_reply_to_id) && !seen.has(cur.comment_id)) {
        seen.add(cur.comment_id);
        cur = byId.get(cur.in_reply_to_id);
      }
      return cur;
    };
    const threads = new Map(); // rootId → [items sorted by created_at]
    for (const c of allRC) {
      const root = rootOf(c);
      if (!root) continue;
      if (!threads.has(root.comment_id)) threads.set(root.comment_id, []);
      threads.get(root.comment_id).push(c);
    }
    for (const items of threads.values()) {
      items.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
    }

    const droppedRoots = new Set();
    for (const [rootId, items] of threads.entries()) {
      if (items.length < 2) continue;
      const last = items[items.length - 1];
      const root = items[0];
      const prAuthor = prAuthors[root.pr_number];
      if (last.author === prAuthor && RESOLVED_BY_AUTHOR_RE.test(last.body ?? "")) {
        droppedRoots.add(rootId);
        continue;
      }
      // Reviewer rescinded their own objection: the root must be opened by
      // someone other than the PR author (otherwise we'd drop a thread the
      // PR author started to self-annotate, throwing away reviewer replies
      // sandwiched in between), and the last comment must come from that
      // same reviewer.
      if (
        root.author !== prAuthor &&
        last.author === root.author &&
        RESOLVED_BY_REVIEWER_RE.test(last.body ?? "")
      ) {
        droppedRoots.add(rootId);
      }
    }

    const before = reviewComments.length;
    reviewComments = reviewComments.filter((c) => {
      const root = rootOf(c);
      return !(root && droppedRoots.has(root.comment_id));
    });
    stats.droppedResolvedItems = before - reviewComments.length;
  }

  // ---- Step 2: PR-author self-comments (on what survived step 1) ----
  if (dropPrAuthor) {
    const filterSelf = (arr) =>
      arr.filter((c) => {
        if (isPrAuthor(c)) {
          stats.droppedSelfComments++;
          return false;
        }
        return true;
      });
    issueComments = filterSelf(issueComments);
    reviewComments = filterSelf(reviewComments);
    reviewSubmissions = filterSelf(reviewSubmissions);
  }

  // ---- Step 3: weight by review state (× optional time-decay) ----
  const halfLifeMonths = opts.timeDecayHalfLifeMonths ?? 0; // 0 disables
  const now = opts.now ?? new Date();
  const weigh = (arr, getState, getDate) =>
    arr.map((c) => {
      const stateW = weighByState ? defaultWeightForState(getState(c)) : 1.0;
      const decayW = halfLifeMonths > 0
        ? timeDecayWeight(getDate(c), now, halfLifeMonths)
        : 1.0;
      return { ...c, weight: stateW * decayW };
    });

  const reviewState = new Map((data.review_submissions ?? []).map((r) => [r.review_id, r.state]));
  issueComments = weigh(issueComments, () => "COMMENTED", (c) => c.created_at);
  reviewComments = weigh(reviewComments, (c) => reviewState.get(c.pull_request_review_id) ?? "COMMENTED", (c) => c.created_at);
  reviewSubmissions = weigh(reviewSubmissions, (c) => c.state, (c) => c.submitted_at);

  return {
    ...data,
    issue_comments: issueComments,
    review_comments: reviewComments,
    review_submissions: reviewSubmissions,
    _signalStats: stats,
  };
}
