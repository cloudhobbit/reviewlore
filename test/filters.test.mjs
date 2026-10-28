import { test } from "node:test";
import assert from "node:assert/strict";
import { sinceFromMonths, isWithinRange, dedupBy, isPlainIssueComment, filterSince } from "../lib/filters.mjs";

test("sinceFromMonths subtracts whole months", () => {
  const now = new Date("2026-05-16T12:00:00Z");
  const since = sinceFromMonths(6, now);
  assert.equal(since.getUTCMonth(), 10); // Nov (0-indexed)
  assert.equal(since.getUTCFullYear(), 2025);
});

test("isWithinRange compares against since", () => {
  const since = new Date("2026-01-01T00:00:00Z");
  assert.equal(isWithinRange("2026-02-01T00:00:00Z", since), true);
  assert.equal(isWithinRange("2025-12-31T23:59:59Z", since), false);
});

test("dedupBy keeps last occurrence by key", () => {
  const arr = [
    { id: 1, name: "a" },
    { id: 2, name: "b" },
    { id: 1, name: "a2" },
  ];
  const out = dedupBy(arr, "id");
  assert.equal(out.length, 2);
  assert.equal(out.find((x) => x.id === 1).name, "a2");
});
test("sinceFromMonths handles month-end without drifting into wrong month", () => {
  // 2026-03-31 minus 1 month: naive setMonth rolls Feb 31 → Mar 3.
  const since = sinceFromMonths(1, new Date("2026-03-31T00:00:00Z"));
  assert.equal(since.getUTCMonth(), 1, "should land in February, not March");
  assert.equal(since.getUTCFullYear(), 2026);
  assert.equal(since.getUTCDate(), 28, "should clamp to Feb 28 (2026 is not a leap year)");
});

test("sinceFromMonths clamps to Feb 29 in a leap year", () => {
  // 2024-03-31 minus 1 month → Feb 29 (leap year).
  const since = sinceFromMonths(1, new Date("2024-03-31T00:00:00Z"));
  assert.equal(since.getUTCMonth(), 1);
  assert.equal(since.getUTCDate(), 29);
});

test("sinceFromMonths handles year boundary at month-end", () => {
  // 2025-05-31 minus 3 months → Feb 28 2025 (not Mar 3).
  const since = sinceFromMonths(3, new Date("2025-05-31T00:00:00Z"));
  assert.equal(since.getUTCFullYear(), 2025);
  assert.equal(since.getUTCMonth(), 1);
  assert.equal(since.getUTCDate(), 28);
});

test("sinceFromMonths crosses calendar year boundary correctly", () => {
  // 2026-01-31 minus 2 months → Nov 30 2025.
  const since = sinceFromMonths(2, new Date("2026-01-31T00:00:00Z"));
  assert.equal(since.getUTCFullYear(), 2025);
  assert.equal(since.getUTCMonth(), 10); // Nov
  assert.equal(since.getUTCDate(), 30);
});

test("isPlainIssueComment: /issues/ URLs are plain issues, /pull/ and unknown URLs are not", () => {
  assert.equal(isPlainIssueComment({ html_url: "https://github.com/o/r/issues/12#issuecomment-1" }), true);
  assert.equal(isPlainIssueComment({ html_url: "https://github.com/o/r/pull/12#issuecomment-1" }), false);
  // Fixtures use placeholder URLs; those must be kept, not dropped.
  assert.equal(isPlainIssueComment({ html_url: "u1" }), false);
  assert.equal(isPlainIssueComment({}), false);
});

test("isPlainIssueComment ignores an 'issues' path segment elsewhere in the URL", () => {
  assert.equal(isPlainIssueComment({ html_url: "https://github.com/issues/123/pull/5#issuecomment-1" }), false);
  assert.equal(isPlainIssueComment({ html_url: "https://github.com/o/r/issues/5" }), true);
});

test("filterSince keeps comments and reviews inside the window", () => {
  const data = {
    meta: { owner: "o" },
    issue_comments: [{ created_at: "2026-01-01T00:00:00Z" }, { created_at: "2025-01-01T00:00:00Z" }],
    review_comments: [{ created_at: "2026-02-01T00:00:00Z" }],
    review_submissions: [{ submitted_at: "2025-06-01T00:00:00Z" }, { submitted_at: null }],
  };
  const out = filterSince(data, new Date("2025-12-01T00:00:00Z"));
  assert.equal(out.meta.owner, "o");
  assert.equal(out.issue_comments.length, 1);
  assert.equal(out.review_comments.length, 1);
  assert.equal(out.review_submissions.length, 0);
});

