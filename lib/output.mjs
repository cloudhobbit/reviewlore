import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { dedupBy } from "./filters.mjs";

export function buildOutput({
  owner,
  repo,
  since,
  monthsBack,
  issueComments,
  reviewComments,
  reviewSubmissions,
  prAuthors = {},
  host,
}) {
  const i = dedupBy(issueComments, "comment_id");
  const r = dedupBy(reviewComments, "comment_id");
  const s = dedupBy(reviewSubmissions, "review_id");
  return {
    meta: {
      owner,
      repo,
      // Only for GitHub Enterprise / GHE.com: older readers treat a corpus
      // without `host` as github.com.
      ...(host && host !== "github.com" ? { host } : {}),
      fetched_at: new Date().toISOString(),
      since: since.toISOString(),
      months_back: monthsBack,
      totals: {
        issue_comments: i.length,
        review_comments: r.length,
        review_submissions: s.length,
        total: i.length + r.length + s.length,
      },
      // PR author per PR number — used downstream to filter PR-author
      // self-comments and detect resolved threads.
      pr_authors: prAuthors,
    },
    issue_comments: i,
    review_comments: r,
    review_submissions: s,
  };
}

export function writeSingleFile(output, { outDir = ".", repo }) {
  mkdirSync(outDir, { recursive: true });
  const filename = join(outDir, `pr-comments-${repo}-${Date.now()}.json`);
  writeFileSync(filename, JSON.stringify(output, null, 2), "utf-8");
  return filename;
}

export function writePerMonth(output, { outDir, repo }) {
  mkdirSync(outDir, { recursive: true });
  const buckets = new Map();
  const bucketize = (item, dateField) => {
    const ym = new Date(item[dateField]).toISOString().slice(0, 7);
    if (!buckets.has(ym)) {
      buckets.set(ym, { issue_comments: [], review_comments: [], review_submissions: [] });
    }
    return buckets.get(ym);
  };
  for (const c of output.issue_comments) bucketize(c, "created_at").issue_comments.push(c);
  for (const c of output.review_comments) bucketize(c, "created_at").review_comments.push(c);
  for (const c of output.review_submissions)
    bucketize(c, "submitted_at").review_submissions.push(c);

  const files = [];
  for (const [ym, data] of [...buckets.entries()].sort().reverse()) {
    const filename = join(outDir, `pr-comments-${repo}-${ym}.json`);
    const monthOutput = {
      meta: { ...output.meta, month: ym },
      ...data,
    };
    writeFileSync(filename, JSON.stringify(monthOutput, null, 2), "utf-8");
    files.push(filename);
  }
  return files;
}
