#!/usr/bin/env node
// Real-data eval: comment-level precision / recall of candidate extraction
// against hand-labelled comments sampled from five public repos.
//
//   precision = labelled-positive comments that yield ≥ 1 candidate
//               / all comments that yield ≥ 1 candidate
//   recall    = labelled-positive comments that yield ≥ 1 candidate
//               / all labelled-positive comments
//
// A comment is positive when someone other than the PR author asks for,
// or prescribes, a change to a PR (code, tests, docs, naming, API, or a
// process step). Bot comments, comments on plain issues, and PR-author
// comments are negative by definition. See eval/real/README.md.
//
// Splits: "dev" (vitest, pnpm) is for tuning; "test" (express,
// commander.js, swr) is held out — report it, don't tune against it.
//
//   node eval/run-real-eval.mjs            # summary
//   node eval/run-real-eval.mjs --verbose  # also list misclassified comments
//   node eval/run-real-eval.mjs --check    # exit 1 if below the floors

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { extractCandidates } from "../lib/extract.mjs";
import { rawComments } from "../lib/raw.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const { records } = JSON.parse(readFileSync(join(here, "real", "comments.json"), "utf8"));

// Regression floors for --check (held-out split). Raise them as the
// pipeline improves; never lower them to make a change pass.
const FLOORS = { precision: 0.7, recall: 0.6 };
// Raw mode (candidates --raw, plan 07) has no phrase classifier: its recall
// ceiling is the share of labelled positives that survive the filters. A
// filter change must not quietly cut it.
const RAW_CEILING_FLOOR = 0.9;

const KEY_BY_TYPE = {
  issue_comment: "issue_comments",
  review_comment: "review_comments",
  review_submission: "review_submissions",
};

// Rebuild one fetch-shaped data object per repo so signals (PR-author
// filter, thread resolution) run exactly as they do on a real corpus.
function toCorpora(recs) {
  const byRepo = new Map();
  for (const r of recs) {
    if (!byRepo.has(r.repo)) {
      byRepo.set(r.repo, {
        meta: { pr_authors: {} },
        issue_comments: [], review_comments: [], review_submissions: [],
      });
    }
    const d = byRepo.get(r.repo);
    if (r.is_pr_author) d.meta.pr_authors[r.pr_number] = r.author;
    const id = Number(r.id.split("#")[1]);
    const idField = r.type === "review_submission" ? { review_id: id, submitted_at: r.created_at } : { comment_id: id, created_at: r.created_at };
    d[KEY_BY_TYPE[r.type]].push({
      type: r.type, ...idField, pr_number: r.pr_number, author: r.author,
      author_type: r.author_type, state: r.state, path: r.path,
      in_reply_to_id: r.in_reply_to_id, html_url: r.html_url, body: r.body,
    });
  }
  return byRepo;
}

function evaluate(recs) {
  const flagged = new Map(); // url → triggering sentences
  for (const data of toCorpora(recs).values()) {
    for (const c of extractCandidates(data)) {
      if (!flagged.has(c.url)) flagged.set(c.url, []);
      flagged.get(c.url).push(`${c.kind}: ${c.sentence}`);
    }
  }
  let tp = 0, fp = 0, fn = 0;
  const falsePos = [], falseNeg = [];
  for (const r of recs) {
    const predicted = flagged.has(r.html_url);
    if (predicted && r.label) tp++;
    else if (predicted) { fp++; falsePos.push(r); }
    else if (r.label) { fn++; falseNeg.push(r); }
  }
  const precision = tp + fp === 0 ? 1 : tp / (tp + fp);
  const recall = tp + fn === 0 ? 1 : tp / (tp + fn);
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  return { n: recs.length, positives: tp + fn, predicted: tp + fp, tp, precision, recall, f1, falsePos, falseNeg, flagged };
}

const pct = (x) => `${(x * 100).toFixed(1)}%`;
const snippet = (r) => r.body.replace(/\s+/g, " ").slice(0, 110);
const verbose = process.argv.includes("--verbose");

let held;
// Positives whose comment is in raw mode's output (no budget limit).
function rawCeiling(recs) {
  const shown = new Set();
  for (const data of toCorpora(recs).values()) {
    for (const row of rawComments(data, { budget: Infinity, now: Date.parse("2026-10-27T00:00:00Z") }).rows) shown.add(row.u);
  }
  const positives = recs.filter((r) => r.label === 1);
  const kept = positives.filter((r) => shown.has(r.html_url.slice(r.html_url.indexOf("/pull/") + 6)));
  return { kept: kept.length, total: positives.length, share: positives.length ? kept.length / positives.length : 1, lost: positives.filter((r) => !kept.includes(r)) };
}

let rawFailed = false;
for (const split of ["dev", "test"]) {
  const res = evaluate(records.filter((r) => r.split === split));
  if (split === "test") held = res;
  const raw = rawCeiling(records.filter((r) => r.split === split));
  if (raw.share < RAW_CEILING_FLOOR) rawFailed = true;
  process.stdout.write(
    `${split.padEnd(5)} n=${res.n} positives=${res.positives} flagged=${res.predicted}  ` +
    `precision=${pct(res.precision)} recall=${pct(res.recall)} f1=${res.f1.toFixed(2)}  ` +
    `raw-ceiling=${raw.kept}/${raw.total} (${pct(raw.share)})\n`,
  );
  if (verbose) for (const r of raw.lost) process.stdout.write(`   RAW-LOST ${r.id} [${r.type}] ${snippet(r)}\n`);
  if (verbose) {
    for (const r of res.falsePos) {
      const where = /\/issues\/\d+/.test(r.html_url) ? " on-issue" : "";
      process.stdout.write(`   FP ${r.id} [${r.type}${where}${r.author_type === "Bot" ? " bot" : ""}${r.is_pr_author ? " pr-author" : ""}] ${res.flagged.get(r.html_url).join(" | ").slice(0, 160)}\n`);
    }
    for (const r of res.falseNeg) process.stdout.write(`   FN ${r.id} [${r.type}] ${snippet(r)}\n`);
  }
}

if (process.argv.includes("--check")) {
  const fails = Object.entries(FLOORS).filter(([k, floor]) => held[k] < floor);
  if (fails.length) {
    process.stderr.write(`❌ held-out ${fails.map(([k, f]) => `${k} ${pct(held[k])} < floor ${pct(f)}`).join(", ")}\n`);
    process.exit(1);
  }
  if (rawFailed) {
    process.stderr.write(`❌ raw-mode filters drop too many labelled positives (ceiling below ${pct(RAW_CEILING_FLOOR)})\n`);
    process.exit(1);
  }
  process.stderr.write("✅ held-out split meets the precision / recall floors; raw-mode ceiling holds\n");
}
