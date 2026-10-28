import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { slimCorpus, serializeCorpus, SLIM_VERSION } from "../lib/slim.mjs";
import { extractCandidates, buildClusters, filterClusters } from "../lib/extract.mjs";
import { historyStats } from "../lib/instructions.mjs";
import { applySignals, RESOLVED_BY_AUTHOR_RE, RESOLVED_BY_REVIEWER_RE } from "../lib/signals.mjs";
import { isNoise, looksLikeAIReview, stripMarkdown } from "../lib/normalize.mjs";
import { isPlainIssueComment } from "../lib/filters.mjs";

// A synthetic corpus with the cases that make slimming subtle: resolved
// threads ending in a short "Done", bot threads, PR authors, plain issues,
// praise, AI-style reviews, and recurring requests that must still cluster.
let id = 0;
const t = (day) => `2026-02-${String(day).padStart(2, "0")}T10:00:00Z`;
const ic = (author, pr, body, day, extra = {}) => ({
  type: "issue_comment", comment_id: ++id, pr_number: pr, author, author_type: "User", body,
  created_at: t(day), updated_at: t(day), html_url: `https://github.com/o/r/pull/${pr}#issuecomment-${id}`, ...extra,
});
const rc = (author, pr, body, day, extra = {}) => ({
  type: "review_comment", comment_id: ++id, pr_number: pr, author, author_type: "User", body,
  path: "src/api/handler.ts", line: 10, diff_hunk: "@@ -1 +1 @@\n-old\n+new", in_reply_to_id: null,
  created_at: t(day), updated_at: t(day), html_url: `https://github.com/o/r/pull/${pr}#discussion_r${id}`, ...extra,
});
const rs = (author, pr, body, day, state = "COMMENTED") => ({
  type: "review_submission", review_id: ++id, pr_number: pr, pr_title: `PR ${pr}`, author, author_type: "User",
  state, body, submitted_at: t(day), html_url: `https://github.com/o/r/pull/${pr}#pullrequestreview-${id}`,
});

function fixture() {
  id = 0;
  const pr_authors = { 1: "author1", 2: "author2", 3: "author3", 4: "author4", 5: "author5", 6: "author6", 7: "author7", 99: "nobody" };
  const review_comments = [];
  // Resolved by the PR author with a short "Done": the request must stay dropped.
  const root1 = rc("alice", 1, "Please add a changeset for this public API change.", 1);
  review_comments.push(root1, rc("author1", 1, "Done", 2, { in_reply_to_id: root1.comment_id }));
  // Reviewer withdraws: "nevermind, outdated" (short).
  const root2 = rc("bob", 2, "Avoid using the any type in the request handler.", 3);
  review_comments.push(root2, rc("bob", 2, "nevermind", 4, { in_reply_to_id: root2.comment_id }));
  // Unresolved thread: reviewer root, PR author explains, reviewer insists.
  const root3 = rc("carol", 3, "Please add a changeset describing the new option.", 5);
  review_comments.push(root3,
    rc("author3", 3, "I think it is not needed because nothing user-facing changed here.", 6, { in_reply_to_id: root3.comment_id }),
    rc("carol", 3, "It changes the CLI flags, so please add a changeset anyway.", 7, { in_reply_to_id: root3.comment_id }));
  // Bot root with a human reply.
  const bot = rc("coderabbitai[bot]", 4, "**Summary:** consider renaming this function for clarity.", 8, { author_type: "Bot" });
  review_comments.push(bot, rc("dave", 4, "Please avoid using the any type here, agreed with the bot.", 9, { in_reply_to_id: bot.comment_id }));
  // Standalone: requests, PR-author self-comment, short, bot, AI report.
  review_comments.push(
    rc("alice", 5, "Please add a changeset for this change.", 10),
    rc("dave", 6, "Avoid the any type in the handler signature.", 11),
    rc("author5", 5, "Note to reviewers: this mirrors the previous implementation.", 12),
    rc("bob", 7, "nit", 13),
    rc("judy", 2, "Avoid the any type in this request handler please.", 25, { pull_request_review_id: 900 }),
    rc("renovate[bot]", 7, "This dependency update looks safe to merge automatically.", 14, { author_type: "Bot" }),
  );
  return {
    meta: { owner: "o", repo: "r", fetched_at: t(28), since: t(1), months_back: 6, pr_authors,
      totals: { issue_comments: 6, review_comments: review_comments.length, review_submissions: 4, total: 0 } },
    issue_comments: [
      ic("erin", 5, "Please add a changeset before we merge this one.", 15),
      ic("frank", 6, "Thanks!", 16),
      ic("author6", 6, "Rebased on main and addressed the comments above.", 17),
      ic("grace", 42, "Could you assign this issue to me please?", 18, { html_url: "https://github.com/o/r/issues/42#issuecomment-99" }),
      ic("erin", 7, "We should avoid the any type in public handlers.", 19),
      ic("helen", 1, "Please add a changeset, the release tooling needs one.", 20),
    ],
    review_comments,
    review_submissions: [
      rs("alice", 6, "Please add a changeset and a test for the new flag.", 21, "CHANGES_REQUESTED"),
      rs("bob", 6, "LGTM", 22, "APPROVED"),
      rs("author7", 7, "Self-review: double-checked the edge cases on this PR.", 23),
      rs("ivan", 3, "**Recommendation:** add tests. **Severity:** high — consider coverage.", 24),
      // An empty "changes requested" review: noise, but its inline comment
      // below takes its state weight, so slimming must keep it.
      { ...rs("judy", 2, "", 25, "CHANGES_REQUESTED"), review_id: 900 },
    ],
  };
}

const clustersOf = (data) => filterClusters(buildClusters(extractCandidates(data)), { minOccurrences: 1, minAuthors: 1 });

test("slim output is equivalent for extraction, clustering and history", () => {
  const full = fixture();
  const slim = slimCorpus(full);
  assert.deepEqual(extractCandidates(slim), extractCandidates(full));
  assert.deepEqual(clustersOf(slim), clustersOf(full));
  assert.deepEqual(historyStats(slim), historyStats(full));
  // Resolved-thread detection sees the same threads.
  assert.equal(applySignals(slim)._signalStats.droppedResolvedItems, applySignals(full)._signalStats.droppedResolvedItems);
  assert.ok(applySignals(full)._signalStats.droppedResolvedItems >= 4, "fixture exercises resolution");
});

test("slim drops what no reader uses and keeps every thread member", () => {
  const full = fixture();
  const slim = slimCorpus(full);
  const bodies = (arr) => arr.map((c) => c.body);
  assert.ok(!bodies(slim.issue_comments).includes("Could you assign this issue to me please?"), "plain issue");
  assert.ok(!bodies(slim.issue_comments).includes("Thanks!"), "praise");
  assert.ok(!slim.issue_comments.some((c) => c.author === "author6"), "PR author");
  assert.ok(!slim.review_submissions.some((c) => c.author === "author7" || c.body === "LGTM"));
  assert.ok(!slim.review_comments.some((c) => c.author === "renovate[bot]" || c.body === "nit"));
  // Thread members stay, noisy ones cut to the words resolution detection reads.
  const done = slim.review_comments.find((c) => c.author === "author1");
  assert.equal(done.body, "Done");
  assert.ok(slim.review_comments.some((c) => c.author === "coderabbitai[bot]" && c.body === ""), "bot root kept, body cut");
  assert.ok(slim.review_comments.some((c) => c.author === "author3"), "PR author inside a thread is kept");
  for (const c of [...slim.issue_comments, ...slim.review_comments, ...slim.review_submissions]) {
    for (const f of ["diff_hunk", "updated_at", "pr_title"]) assert.ok(!(f in c), f);
  }
  assert.deepEqual(Object.keys(slim.meta.pr_authors).sort(), ["1", "2", "3", "4", "5", "6", "7"]);
  assert.equal(slim.meta.schema_version, 2);
  assert.equal(slim.meta.slim.version, SLIM_VERSION);
  assert.deepEqual(slim.meta.source_totals, full.meta.totals);
  assert.equal(slim.meta.totals.total, slim.issue_comments.length + slim.review_comments.length + slim.review_submissions.length);
});

test("slimming is idempotent and serialisation is deterministic", () => {
  const once = slimCorpus(fixture());
  const twice = slimCorpus(JSON.parse(serializeCorpus(once)));
  assert.equal(serializeCorpus(twice), serializeCorpus(once));
  // Record order in the input doesn't matter.
  const shuffled = { ...once, review_comments: [...once.review_comments].reverse() };
  assert.equal(serializeCorpus(shuffled), serializeCorpus(once));
  const text = serializeCorpus(once);
  JSON.parse(text);
  const lines = text.split("\n");
  assert.ok(lines.filter((l) => l.startsWith('{"type":"review_comment"')).length === once.review_comments.length, "one record per line");
  const dates = once.issue_comments.map((c) => c.created_at);
  const serialisedDates = JSON.parse(text).issue_comments.map((c) => c.created_at);
  assert.deepEqual(serialisedDates, [...dates].sort());
});

test("a noisy reply whose resolution words are long keeps its body, so it stays noise", () => {
  const data = fixture();
  const reply = data.review_comments.find((c) => c.author === "author1");
  // AI-report style (noise), with both resolution phrases: cut to
  // "good catch never mind" (21 chars) it would stop being noise.
  reply.body = "**Recommendation:** good catch — never mind the earlier note. **Severity:** low";
  assert.equal(isNoise(reply), true);
  const slim = slimCorpus(data);
  const kept = slim.review_comments.find((c) => c.author === "author1");
  assert.equal(kept.body, reply.body);
  assert.equal(isNoise(kept), true);
  assert.deepEqual(extractCandidates(slim), extractCandidates(data));
});

test("MCP tools answer the same from a slim corpus", async () => {
  const { searchRules, recentFeedback, reviewFeedbackForPath, searchReviewFeedback } = await import("../lib/mcp-tools.mjs");
  const before = { project: process.env.REVIEWLORE_PROJECT_DIR, cache: process.env.REVIEWLORE_CACHE_DIR };
  const answers = async (data) => {
    const dir = mkdtempSync(join(tmpdir(), "slim-mcp-"));
    try {
      writeFileSync(join(dir, ".reviewlore-corpus.json"), JSON.stringify(data));
      process.env.REVIEWLORE_PROJECT_DIR = dir;
      process.env.REVIEWLORE_CACHE_DIR = join(dir, "no-cache");
      const strip = ({ source, age_days, ...rest }) => rest; // where the data came from differs
      return [
        await searchRules({ owner: "o", repo: "r" }),
        await searchRules({ owner: "o", repo: "r", topic: "changeset" }),
        await recentFeedback({ owner: "o", repo: "r", path: "src", months: 1200, limit: 50 }),
        strip(await reviewFeedbackForPath({ owner: "o", repo: "r", path: "src/api/handler.ts", months: 1200 })),
        strip(await searchReviewFeedback({ owner: "o", repo: "r", query: "changeset any type" })),
      ];
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  try {
    const full = fixture();
    const fromFull = await answers(full);
    assert.ok(fromFull[2].comments.length > 0 && fromFull[4].results.length > 0);
    assert.deepEqual(await answers(JSON.parse(serializeCorpus(slimCorpus(full)))), fromFull);
  } finally {
    for (const [k, v] of [["REVIEWLORE_PROJECT_DIR", before.project], ["REVIEWLORE_CACHE_DIR", before.cache]]) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

// The slim rule is exact only while the filters it mirrors stay the same.
// If this fails: re-check equivalence (the tests above, and the manual
// comparison on real corpora in docs/plans/05-slim-corpus.md). If slimming
// is still exact, update FILTERS_HASH; if not, change lib/slim.mjs and bump
// SLIM_VERSION.
const FILTERS_HASH = "81b9681f65bcb87d";
test("the filters the slim rule depends on are unchanged", () => {
  const normalize = readFileSync(new URL("../lib/normalize.mjs", import.meta.url), "utf-8");
  const constants = normalize.slice(normalize.indexOf("const BOT_USER_TYPES"), normalize.indexOf("export function looksLikeAIReview"));
  const source = [
    constants, isNoise, looksLikeAIReview, stripMarkdown, isPlainIssueComment, applySignals,
    RESOLVED_BY_AUTHOR_RE.source, RESOLVED_BY_REVIEWER_RE.source,
  ].map(String).join("\n");
  assert.equal(createHash("sha256").update(source).digest("hex").slice(0, 16), FILTERS_HASH);
});
