import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildOutput, writeSingleFile, writePerMonth } from "../lib/output.mjs";

const mkIssueComment = (id, ym, author = "alice") => ({
  comment_id: id,
  pr_number: id,
  author,
  body: "x",
  created_at: `${ym}-15T12:00:00Z`,
  html_url: "u",
});
const mkReviewComment = (id, ym) => ({
  comment_id: id,
  pr_number: id,
  body: "y",
  created_at: `${ym}-10T12:00:00Z`,
  html_url: "u",
});
const mkReviewSub = (id, ym) => ({
  review_id: id,
  pr_number: id,
  body: "z",
  submitted_at: `${ym}-20T12:00:00Z`,
  html_url: "u",
});

const buildSample = () =>
  buildOutput({
    owner: "x",
    repo: "y",
    since: new Date("2025-11-01T00:00:00Z"),
    monthsBack: 6,
    issueComments: [mkIssueComment(1, "2025-12"), mkIssueComment(2, "2026-01")],
    reviewComments: [mkReviewComment(10, "2025-12")],
    reviewSubmissions: [mkReviewSub(100, "2026-01"), mkReviewSub(101, "2026-02")],
  });

test("buildOutput aggregates totals correctly", () => {
  const out = buildSample();
  assert.equal(out.meta.totals.issue_comments, 2);
  assert.equal(out.meta.totals.review_comments, 1);
  assert.equal(out.meta.totals.review_submissions, 2);
  assert.equal(out.meta.totals.total, 5);
});

test("buildOutput dedupes by comment_id / review_id", () => {
  const out = buildOutput({
    owner: "x",
    repo: "y",
    since: new Date(),
    monthsBack: 1,
    issueComments: [mkIssueComment(1, "2026-01"), mkIssueComment(1, "2026-01")],
    reviewComments: [],
    reviewSubmissions: [],
  });
  assert.equal(out.issue_comments.length, 1);
});

test("writeSingleFile writes a single timestamped JSON in outDir", () => {
  const tmp = mkdtempSync(join(tmpdir(), "pr-out-"));
  try {
    const out = buildSample();
    const filename = writeSingleFile(out, { outDir: tmp, repo: "y" });
    assert.match(filename, /pr-comments-y-\d+\.json$/);
    const parsed = JSON.parse(readFileSync(filename, "utf-8"));
    assert.equal(parsed.meta.totals.total, 5);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("writePerMonth buckets by YYYY-MM and writes one file per month", () => {
  const tmp = mkdtempSync(join(tmpdir(), "pr-out-"));
  try {
    const out = buildSample();
    const files = writePerMonth(out, { outDir: tmp, repo: "y" });
    // We have data in 2025-12, 2026-01, 2026-02 — expect 3 files.
    assert.equal(files.length, 3);
    const months = readdirSync(tmp).map((f) => f.match(/(\d{4}-\d{2})\.json$/)?.[1]).sort();
    assert.deepEqual(months, ["2025-12", "2026-01", "2026-02"]);

    // Each file should only contain its bucket's items.
    const dec = JSON.parse(readFileSync(join(tmp, "pr-comments-y-2025-12.json"), "utf-8"));
    assert.equal(dec.issue_comments.length, 1);
    assert.equal(dec.review_comments.length, 1);
    assert.equal(dec.review_submissions.length, 0);
    assert.equal(dec.meta.month, "2025-12");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
