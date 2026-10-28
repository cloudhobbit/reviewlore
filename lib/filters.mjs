export function sinceFromMonths(monthsBack, now = new Date()) {
  // Use UTC year/month arithmetic and clamp the day to the last valid day
  // of the target month. Naive `setMonth(getMonth() - n)` rolls Feb 31 over
  // into March, silently narrowing the fetch window on month-end runs.
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const day = now.getUTCDate();
  const targetYear = y + Math.floor((m - monthsBack) / 12);
  const targetMonth = ((m - monthsBack) % 12 + 12) % 12;
  // Last day of targetMonth: day 0 of targetMonth+1.
  const lastDay = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
  const clampedDay = Math.min(day, lastDay);
  return new Date(Date.UTC(
    targetYear,
    targetMonth,
    clampedDay,
    now.getUTCHours(),
    now.getUTCMinutes(),
    now.getUTCSeconds(),
    now.getUTCMilliseconds(),
  ));
}

export function isWithinRange(dateStr, since) {
  return new Date(dateStr) >= since;
}

export function dedupBy(arr, key) {
  return [...new Map(arr.map((x) => [x[key], x])).values()];
}

// `issues.listCommentsForRepo` returns comments on PRs *and* on plain
// issues. Only PR conversation is review feedback. GitHub links a plain
// issue comment as .../issues/<n>#issuecomment-…, a PR one as
// .../pull/<n>#issuecomment-…. Matching the /issues/ form (rather than
// requiring /pull/) keeps comments whose URL is unknown, e.g. fixtures.
// GitLab notes come from merge-request discussions only, and their
// /-/merge_requests/ links never match.
export function isPlainIssueComment(c) {
  return /\/issues\/\d+(?:[#?]|$)/.test(c?.html_url ?? "");
}

// Keep only comments created (or reviews submitted) on or after `since`.
// Used to apply a lookback window to the merged cache or a committed
// corpus, which can both span more history than the user asked for.
export function filterSince(data, since) {
  const inWindow = (date) => date != null && isWithinRange(date, since);
  return {
    ...data,
    issue_comments: (data.issue_comments ?? []).filter((c) => inWindow(c.created_at)),
    review_comments: (data.review_comments ?? []).filter((c) => inWindow(c.created_at)),
    review_submissions: (data.review_submissions ?? []).filter((c) => inWindow(c.submitted_at)),
  };
}
