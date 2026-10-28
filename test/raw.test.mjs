import { test } from "node:test";
import assert from "node:assert/strict";
import { rawComments } from "../lib/raw.mjs";

const t = (d) => `2026-09-${String(d).padStart(2, "0")}T10:00:00Z`;
let n = 0;
const ic = (author, pr, body, day, extra = {}) => ({ type: "issue_comment", comment_id: ++n, pr_number: pr, author, author_type: "User", body, created_at: t(day), html_url: `https://ghe.acme.corp/o/r/pull/${pr}#issuecomment-${n}`, ...extra });
const rc = (author, pr, path, body, day, extra = {}) => ({ type: "review_comment", comment_id: ++n, pr_number: pr, author, author_type: "User", body, path, in_reply_to_id: null, created_at: t(day), html_url: `https://ghe.acme.corp/o/r/pull/${pr}#discussion_r${n}`, ...extra });

function data() {
  n = 0;
  return {
    meta: { owner: "o", repo: "r", fetched_at: t(30), pr_authors: { 1: "author" }, totals: { total: 9 } },
    issue_comments: [
      ic("anna", 2, "Bitte einen Test für den leeren Fall ergänzen.", 2),
      ic("ken", 3, "このテストは既存のスイートに移動してください。", 3),
      ic("author", 1, "Updated the branch, thanks for the review!", 4),
      ic("dependabot[bot]", 4, "Bumps lodash from 4.17.20 to 4.17.21.", 5, { author_type: "Bot" }),
      ic("bob", 5, "LGTM", 6),
      ic("carl", 6, "This belongs in the existing suite.", 7),
    ],
    review_comments: [
      rc("dina", 7, "packages/a/x.ts", "Kann das nicht in den bestehenden Helper? " + "x".repeat(300), 8),
      rc("dina", 8, "packages/a/y.ts", "Noch ein Hinweis zu diesem Paket.", 9),
      rc("erik", 9, "docs/guide.md", "Die Doku sollte das neue Flag erwähnen.", 10),
    ],
    review_submissions: [],
  };
}

test("raw mode keeps human comments in any language and drops bots, PR authors and praise", () => {
  const { rows, stats, url_base } = rawComments(data());
  const texts = rows.map((r) => r.text);
  assert.ok(texts.includes("Bitte einen Test für den leeren Fall ergänzen."), "German survives (no English classifier)");
  assert.ok(texts.some((x) => x.startsWith("このテスト")), "Japanese survives");
  assert.ok(texts.includes("This belongs in the existing suite."), "English without request phrasing survives");
  assert.ok(!rows.some((r) => ["author", "dependabot[bot]"].includes(r.by) || r.text === "LGTM"));
  assert.equal(url_base, "https://ghe.acme.corp/o/r/pull/");
  assert.ok(rows.every((r) => /^\d+#/.test(r.u)));
  assert.equal(stats.survivors, 6);
  assert.ok(stats.non_ascii_share > 0);
});

test("raw mode: truncation, budget, round-robin across directories, deterministic", () => {
  const all = rawComments(data(), { maxChars: 60 });
  const long = all.rows.find((r) => r.text.startsWith("Kann das"));
  assert.equal(long.text.length, 60);
  assert.ok(long.text.endsWith("…"));
  assert.equal(all.stats.truncated, 1);
  // A small budget keeps the first of each directory before a second from any.
  const small = rawComments(data(), { budget: 120 });
  assert.ok(small.stats.dropped_for_budget > 0);
  assert.ok(small.stats.est_tokens <= 120);
  const groups = small.rows.map((r) => (r.path ?? "").split("/")[0]);
  assert.equal(new Set(groups).size, groups.length, "no directory twice before every one had a turn");
  assert.deepEqual(rawComments(data()), rawComments(data()));
});
