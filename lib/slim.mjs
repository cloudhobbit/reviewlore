// The committed corpus, slimmed (docs/plans/05-slim-corpus.md): only what
// extraction, `candidates` and the MCP tools can ever use, one record per
// line in a fixed order so refreshes produce small, reviewable diffs.
//
// The rule is exact — the same `candidates`, `run` and MCP output as the
// full cache — because every reader drops the same things first:
//   - plain-issue comments, PR authors' own comments and noise (bots,
//     AI-written reviews, short replies, praise) are dropped...
//   - ...except review comments in a reply thread: resolved-thread
//     detection reads the thread's last reply ("Done" from the PR author,
//     usually noise itself). A noisy thread member keeps only the words
//     that detection looks for.
//   - a review that a kept inline comment was posted in stays (body
//     emptied if it's noise): the comment takes its state weight.
//   - diff_hunk, updated_at and pr_title are read by nothing.
// Change any of those filters and this rule must change with them: bump
// SLIM_VERSION (test/slim.test.mjs pins the filters' sources).

import { isPlainIssueComment } from "./filters.mjs";
import { isNoise } from "./normalize.mjs";
import { RESOLVED_BY_AUTHOR_RE, RESOLVED_BY_REVIEWER_RE } from "./signals.mjs";

export const SLIM_VERSION = 1;
export const CORPUS_SCHEMA_VERSION = 2;

const FIELDS = {
  issue_comments: ["type", "comment_id", "pr_number", "author", "author_type", "body", "created_at", "html_url"],
  review_comments: ["type", "comment_id", "pr_number", "author", "author_type", "body", "path", "line", "in_reply_to_id", "pull_request_review_id", "created_at", "html_url"],
  review_submissions: ["type", "review_id", "pr_number", "author", "author_type", "state", "body", "submitted_at", "html_url"],
};

function pick(record, fields) {
  const out = {};
  for (const f of fields) if (record[f] !== undefined) out[f] = record[f];
  return out;
}

// What resolved-thread detection needs from a noisy reply: the matched
// words. Longer than 20 characters it could stop being noise, so then the
// original body stays.
function resolutionWords(body) {
  const words = [body?.match(RESOLVED_BY_AUTHOR_RE)?.[0], body?.match(RESOLVED_BY_REVIEWER_RE)?.[0]]
    .filter(Boolean).join(" ");
  return words.length < 20 ? words : body;
}

export function slimCorpus(data) {
  const prAuthors = data.meta?.pr_authors ?? {};
  const isPrAuthor = (c) => c.pr_number != null && c.author === prAuthors[c.pr_number];
  const dropped = { plain_issue: 0, pr_author: 0, noise: 0 };
  const keep = (c) => {
    if (isPrAuthor(c)) dropped.pr_author++;
    else if (isNoise(c)) dropped.noise++;
    else return true;
    return false;
  };

  const issueComments = (data.issue_comments ?? []).filter((c) => {
    if (isPlainIssueComment(c)) {
      dropped.plain_issue++;
      return false;
    }
    return keep(c);
  });

  const reviewComments = data.review_comments ?? [];
  const repliedTo = new Set(reviewComments.map((c) => c.in_reply_to_id).filter((id) => id != null));
  const inThread = (c) => c.in_reply_to_id != null || repliedTo.has(c.comment_id);
  const slimReviewComments = [];
  for (const c of reviewComments) {
    if (inThread(c)) slimReviewComments.push(isNoise(c) ? { ...c, body: resolutionWords(c.body) } : c);
    else if (keep(c)) slimReviewComments.push(c);
  }

  // Reviews whose state a kept inline comment inherits (lib/signals.mjs).
  // "Changes requested" reviews often have no body, so they're noise.
  const parentReviews = new Set(slimReviewComments.map((c) => c.pull_request_review_id).filter((id) => id != null));
  const reviewSubmissions = [];
  for (const c of data.review_submissions ?? []) {
    if (parentReviews.has(c.review_id)) reviewSubmissions.push(isNoise(c) ? { ...c, body: "" } : c);
    else if (keep(c)) reviewSubmissions.push(c);
  }

  const out = {
    issue_comments: issueComments.map((c) => pick(c, FIELDS.issue_comments)),
    review_comments: slimReviewComments.map((c) => pick(c, FIELDS.review_comments)),
    review_submissions: reviewSubmissions.map((c) => pick(c, FIELDS.review_submissions)),
  };
  const referenced = new Set([...out.issue_comments, ...out.review_comments, ...out.review_submissions].map((c) => String(c.pr_number)));
  const previous = data.meta?.slim?.dropped ?? {};
  const totals = {
    issue_comments: out.issue_comments.length,
    review_comments: out.review_comments.length,
    review_submissions: out.review_submissions.length,
  };
  totals.total = totals.issue_comments + totals.review_comments + totals.review_submissions;
  return {
    meta: {
      ...data.meta,
      schema_version: CORPUS_SCHEMA_VERSION,
      totals,
      // What was fetched, before slimming: what users expect to see counted.
      source_totals: data.meta?.source_totals ?? data.meta?.totals,
      pr_authors: Object.fromEntries(Object.entries(prAuthors).filter(([pr]) => referenced.has(pr))),
      slim: {
        version: SLIM_VERSION,
        dropped: Object.fromEntries(Object.entries(dropped).map(([k, n]) => [k, n + (previous[k] ?? 0)])),
      },
    },
    ...out,
  };
}

const dateOf = (c) => c.created_at ?? c.submitted_at ?? "";
const idOf = (c) => c.comment_id ?? c.review_id ?? 0;
const byDateThenId = (a, b) => dateOf(a).localeCompare(dateOf(b)) || idOf(a) - idOf(b);

// Valid JSON with one record per line, records sorted by date then id,
// fields in a fixed order: the same corpus always gives the same bytes,
// and a refresh diff shows only the records that changed.
export function serializeCorpus(data) {
  const section = (key) => {
    const records = [...(data[key] ?? [])].sort(byDateThenId).map((c) => JSON.stringify(pick(c, FIELDS[key])));
    return `"${key}":[${records.length ? `\n${records.join(",\n")}\n` : ""}]`;
  };
  return `{"meta":${JSON.stringify(data.meta ?? {})},\n${Object.keys(FIELDS).map(section).join(",\n")}}\n`;
}
