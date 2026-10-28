#!/usr/bin/env node
// Eval harness: runs each pipeline engine against labeled fixtures and
// reports precision / recall.
//
//   precision = (generated rules that match an expected rule) / (generated rules)
//   recall    = (expected rules that match a generated rule)  / (expected rules)
//
// "Match" criteria:
//   1. Generated rule's tokens (label) intersect with expected.keywords
//      with ≥ 2 keywords present.
//   2. AND at least one PR cited in the rule's items appears in
//      expected.must_cite_prs.
//
// Also checks expected_false_positives: each is a named anti-pattern that
// the tool must NOT surface. Counts contribute to a separate "noise" score.

import { readFileSync, readdirSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { extractCandidates, buildClusters, filterClusters } from "../lib/extract.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(here, "fixtures");

const MIN_KEYWORD_OVERLAP = 2;
const DEFAULTS = { minOccurrences: 3, minAuthors: 2, threshold: 0.34 };

function ruleMatchesExpected(cluster, expected) {
  const ruleTokens = new Set(cluster.label);
  const itemTokens = new Set(cluster.items.flatMap((i) => i.tokens));
  const allTokens = new Set([...ruleTokens, ...itemTokens]);
  const keywordHits = expected.keywords.filter((k) => allTokens.has(k.toLowerCase())).length;
  if (keywordHits < MIN_KEYWORD_OVERLAP) return false;
  const citedPRs = new Set(cluster.items.map((i) => i.pr).filter(Boolean));
  return expected.must_cite_prs.some((pr) => citedPRs.has(pr));
}

function evaluateEngine(name, runPipeline, fixture, labels) {
  const clusters = runPipeline(fixture);

  // Precision: of clusters surfaced, how many match an expected rule?
  let truePositives = 0;
  const unmatched = [];
  for (const cluster of clusters) {
    const matched = labels.expected_rules.some((er) => ruleMatchesExpected(cluster, er));
    if (matched) truePositives++;
    else unmatched.push(cluster);
  }
  const precision = clusters.length === 0 ? 1.0 : truePositives / clusters.length;

  // Recall: of expected rules, how many were surfaced?
  let recalled = 0;
  const missed = [];
  for (const expected of labels.expected_rules) {
    const found = clusters.some((c) => ruleMatchesExpected(c, expected));
    if (found) recalled++;
    else missed.push(expected);
  }
  const recall =
    labels.expected_rules.length === 0 ? 1.0 : recalled / labels.expected_rules.length;

  const f1 =
    precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);

  return {
    name,
    clustersSurfaced: clusters.length,
    truePositives,
    falsePositives: clusters.length - truePositives,
    expectedRules: labels.expected_rules.length,
    recalled,
    missed,
    unmatched,
    precision,
    recall,
    f1,
  };
}

function fmtPct(n) {
  return `${(n * 100).toFixed(1)}%`;
}

function runOne(fixturePath) {
  const fixture = JSON.parse(readFileSync(fixturePath, "utf-8"));
  const labelsPath = fixturePath.replace(/\.json$/, ".labels.json");
  const labels = JSON.parse(readFileSync(labelsPath, "utf-8"));

  console.log(`\n=== Fixture: ${basename(fixturePath)} ===`);
  console.log(`   Expected rules: ${labels.expected_rules.length}`);

  // Engine 1: Jaccard (heuristic baseline, no signal filtering)
  const jaccard = (data) => {
    const c = extractCandidates(data, { skipSignals: true });
    return filterClusters(buildClusters(c, { threshold: DEFAULTS.threshold }), DEFAULTS);
  };

  // Engine 2: Jaccard + signals (PR-author filter, resolved threads, state weighting)
  const jaccardSignals = (data) => {
    const c = extractCandidates(data);
    return filterClusters(buildClusters(c, { threshold: DEFAULTS.threshold }), DEFAULTS);
  };

  // Engine 3: TF-IDF cosine + signals
  const semanticSignals = (data) => {
    const c = extractCandidates(data);
    return filterClusters(
      buildClusters(c, { threshold: 0.30, engine: "semantic" }),
      DEFAULTS,
    );
  };

  const results = [
    evaluateEngine("baseline (no signals)", jaccard, fixture, labels),
    evaluateEngine("+signals", jaccardSignals, fixture, labels),
    evaluateEngine("+signals+semantic", semanticSignals, fixture, labels),
  ];

  console.log();
  console.log("Engine                  | Surfaced | TP | FP | Recall | Precision | F1");
  console.log("------------------------|----------|----|----|--------|-----------|------");
  for (const r of results) {
    console.log(
      `${r.name.padEnd(23)} | ${String(r.clustersSurfaced).padStart(8)} | ${String(r.truePositives).padStart(2)} | ${String(r.falsePositives).padStart(2)} | ${fmtPct(r.recall).padStart(6)} | ${fmtPct(r.precision).padStart(9)} | ${r.f1.toFixed(2)}`,
    );
  }

  for (const r of results) {
    if (r.missed.length > 0) {
      console.log(`\n[${r.name}] Missed:`);
      for (const m of r.missed) console.log(`   - ${m.id}: ${m.summary}`);
    }
    if (r.unmatched.length > 0) {
      console.log(`\n[${r.name}] Unmatched generated:`);
      for (const u of r.unmatched) {
        console.log(`   - "${u.label.join(' / ')}" (${u.occurrences}× / ${u.distinctAuthors} authors)`);
      }
    }
  }

  return results;
}

function main() {
  const files = readdirSync(fixturesDir)
    .filter((f) => f.endsWith(".json") && !f.endsWith(".labels.json"))
    .map((f) => join(fixturesDir, f));

  if (files.length === 0) {
    console.error("No fixtures found in", fixturesDir);
    process.exit(1);
  }

  const allResults = [];
  for (const f of files) allResults.push(...runOne(f));

  // Aggregate per engine
  console.log("\n\n=== Aggregate ===");
  const byEngine = new Map();
  for (const r of allResults) {
    if (!byEngine.has(r.name)) byEngine.set(r.name, []);
    byEngine.get(r.name).push(r);
  }
  for (const [name, runs] of byEngine.entries()) {
    const mean = (k) => runs.reduce((a, b) => a + b[k], 0) / runs.length;
    console.log(
      `${name.padEnd(23)}  recall=${fmtPct(mean("recall"))}  precision=${fmtPct(mean("precision"))}  f1=${mean("f1").toFixed(2)}`,
    );
  }

  // CI gate: refuse to regress on the latest engine's F1 score
  const latestF1 = mean(byEngine.get("+signals+semantic"), "f1");
  const baselineF1 = mean(byEngine.get("baseline (no signals)"), "f1");
  console.log();
  if (latestF1 < baselineF1) {
    console.log(`❌ latest F1 (${latestF1.toFixed(2)}) regressed below baseline (${baselineF1.toFixed(2)})`);
    process.exit(1);
  }
  console.log(`✅ latest F1 (${latestF1.toFixed(2)}) >= baseline (${baselineF1.toFixed(2)})`);
}

function mean(runs, k) {
  return runs.reduce((a, b) => a + b[k], 0) / runs.length;
}

main();
