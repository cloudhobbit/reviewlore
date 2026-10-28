#!/usr/bin/env node
// reviewlore — the single CLI. `run` (default) fetches and
// generates rules in one go; `candidates` prints the extracted review
// feedback as JSON for Claude to synthesise (the plugin skill uses it);
// `fetch`, `generate` and `mcp` are the individual stages.

import { parseArgs, ArgsError } from "../lib/args.mjs";
import { sinceFromMonths, filterSince } from "../lib/filters.mjs";
import { fetchConcurrency } from "../lib/fetchers.mjs";
import { openFetcher } from "../lib/providers/index.mjs";
import { mergeIntoCache, incrementalSince, loadCache } from "../lib/cache.mjs";
import { extractCandidates, buildClusters, filterClusters, pickExamples } from "../lib/extract.mjs";
import { getRenderer, resolveFormats, rendererSummary } from "../lib/renderers/index.mjs";
import { pathGlobs } from "../lib/renderers/_common.mjs";
import { renderSummary } from "../lib/skill-writer.mjs";
import { synthesiseAll } from "../lib/llm.mjs";
import { loadPreviousState, reportDiffSinceLastRun, writeCurrentState } from "../lib/diff.mjs";
import { applyPreset, presetSummary } from "../lib/presets.mjs";
import { findConfigPath, loadConfig, applyConfig, CONFIG_FILENAME } from "../lib/config.mjs";
import { runInitWizard } from "../lib/init-wizard.mjs";
import { findGitToplevel, detectBaseRef, changedPaths, trackedFiles, resolveRepo, repoLabel } from "../lib/git-info.mjs";
import {
  publishCorpus, loadCorpus, corpusInfo, corpusPath, CORPUS_FILENAME,
} from "../lib/corpus.mjs";
import { runDoctor, renderDoctor, PACKAGE_ROOT } from "../lib/doctor.mjs";
import { saveScratch, discardScratch } from "../lib/scratch.mjs";
import { historyStats, findInstructionFiles, explainEmptyResult, diagnoseEmpty } from "../lib/instructions.mjs";
import { explainGitHubError } from "../lib/github-errors.mjs";
import { resolveContext, loadIndex } from "../lib/mcp-tools.mjs";
import { precedentsFor } from "../lib/review-index.mjs";
import { rawComments } from "../lib/raw.mjs";
import { loadManifest, emptyManifest, saveManifest, recordFiles, urlDates, GENERATORS, MANIFEST_FILE } from "../lib/rules-manifest.mjs";
import { ruleStatus, renderStatus } from "../lib/rule-status.mjs";
import { resolve, dirname, join } from "node:path";
import { existsSync, statSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const VERSION = "0.3.0";

const HELP = `reviewlore v${VERSION}

Turn a repo's PR review history into rules for Claude Code and other AI
coding tools.

Commands:
  run (default)    Fetch review comments and write rule files in one go.
  candidates       Print the extracted review feedback as JSON (for Claude
                   to synthesise rules from — used by the Claude Code plugin).
  fetch            Fetch review comments to JSON only.
  generate         Write rules from a fetched JSON file.
  mcp              Start the MCP server on stdio.
  doctor           Check Node, dependencies, git and the repo (offline).
  precedents       What review history says about the current changes, as
                   JSON (used by the review-my-changes skill). Offline.
  rules            Track generated rules: record, status, dismiss, retire.
  export           Copy the reviewed rules to Copilot, Claude Code Review,
                   AGENTS.md, Cursor or CLAUDE.md.
  init             Interactive setup wizard.
  publish-corpus   Commit-able corpus so teammates need no token.

  reviewlore <command> --help   shows a command's own options
  (fetch / generate / mcp / export).

Usage:
  reviewlore run                 — from inside a git repo, zero args needed:
                                            auto-detects --owner/--repo from
                                            git remote, --target defaults to cwd.
                                            Uses ${CORPUS_FILENAME}
                                            if present (no token needed).
  reviewlore run --owner <o> --repo <r> --target <path> [options]
  reviewlore init                — interactive setup wizard, writes ${CONFIG_FILENAME}
  reviewlore publish-corpus      — copy the cached PR-comment JSON into
                                            the target repo so teammates can run
                                            with zero auth (no token needed).
  reviewlore candidates [--limit <n>] [--min-occurrences <n>]
                                          — same repo/corpus detection as run;
                                            prints JSON to stdout, writes nothing.
                                            --save writes it to a private temp
                                            file and prints only the path;
                                            --discard <path> deletes that file;
                                            --demo prints a bundled sample
                                            (vitest's history) instead.
                                            --raw prints whole human comments
                                            in any language (JSONL) under
                                            --budget <tokens> (default 60000),
                                            each cut at --max-chars (1200).
  reviewlore doctor [--json]    — offline readiness check; exit 1 if
                                            something required is missing.
  reviewlore rules status [--json] [--months 6]
                                          — are the generated rules still backed
                                            by review history and existing paths?
  reviewlore rules record <file…> | --all [--generator g] [--query words]
  reviewlore rules dismiss <file…> | --title "…" --urls a,b [--reason r]
  reviewlore rules retire <file…>
                                          — keep ${MANIFEST_FILE} in step
                                            (the plugin skill runs these).
  reviewlore precedents [--base <ref>] [--paths a,b] [--limit 8] [--months 12]
                                          — rules, recurring feedback and file
                                            history for the files changed since
                                            the base branch (or --paths). JSON on
                                            stdout; problems as "status", exit 0.

Options:
  --owner <name>           GitHub owner/org (auto-detected from git remote if omitted).
  --repo <name>            GitHub repo (auto-detected from git remote if omitted).
  --target <path>          Target directory (default: the git root of the current directory).
  --months <n>             Lookback window (default: 6).
  --format <name(s)>       Output format. Default: claude. Supported:
${rendererSummary()}
                           Also: 'auto' (detect from target's files),
                           'all' (every renderer), or comma-separated list
                           (e.g. claude,cursor,html).
  --min-occurrences <n>    Min distinct (reviewer, PR) pairs per rule (default: 3; candidates: 1).
  --min-authors <n>        Min distinct reviewers per rule (default: 2; candidates: 1).
  --single-reviewer        Single-maintainer repos: one reviewer on 3+ PRs is enough;
                           such rules are titled "Maintainer preference: …".
  --engine <name>          jaccard (default) | semantic.
  --threshold <0-1>        Clustering similarity threshold (default depends on --engine).
  --llm                    Use Claude to synthesise polished rules.
  --api-key <key>          Anthropic API key (falls back to ANTHROPIC_API_KEY).
  --token <token>          GitHub token (falls back to GH_TOKEN / GITHUB_TOKEN, then
                           'gh auth token --hostname <host>'; on GitHub Enterprise
                           Server, GH_ENTERPRISE_TOKEN instead of GITHUB_TOKEN).
  --host <name>            GitHub host: github.com, <sub>.ghe.com or a GitHub Enterprise
                           Server host (default: the git remote's host, then GH_HOST).
  --api-url <url>          REST API base URL, if not the host's standard one.
  --provider <name>        github (default) or gitlab. GitLab is detected for gitlab.com
                           and hosts named gitlab.*; pass it for other self-managed GitLab.
  --no-cache               Skip the persistent cache.
  --refresh                Ignore any in-repo corpus and re-fetch from GitHub.
                           (Default: use ${CORPUS_FILENAME}
                            if present, fall back to fetching.)
  --force / -f             Overwrite existing output files.
  --dry-run                Run the pipeline but don't write any files.
  --preset <name>          Tuning profile (sets defaults for multiple flags):
${presetSummary()}
                           Explicit flags override preset values.
  --time-decay-half-life <n> Months; older comments rank lower (default: 0 = off).
  --version
  --help

Examples:

  # Zero-arg run from inside a cloned project:
  cd ~/code/my-project && reviewlore run

  # Last year, with HTML report alongside Claude rules:
  reviewlore run --months 12 --format claude,html

  # Cursor format with LLM-synthesised rules:
  reviewlore run --format cursor --llm

  # Different account's token (doesn't touch your gh CLI auth):
  GITHUB_TOKEN=ghp_yyy reviewlore run --months 12

  # Feedback as JSON, for Claude (or jq) to work with:
  reviewlore candidates --limit 100 > feedback.json
`;

// Validate the clustering flags shared by `run` and `candidates`. Returns
// { options } or { error }.
function clusterOptions(args, { minOccurrences: defOcc, minAuthors: defAuthors }) {
  const minOccurrences = Number(args["min-occurrences"] ?? defOcc);
  const minAuthors = Number(args["min-authors"] ?? defAuthors);
  for (const [flag, v] of [["min-occurrences", minOccurrences], ["min-authors", minAuthors]]) {
    if (!Number.isInteger(v) || v < 1) return { error: `--${flag} must be a positive integer (got "${args[flag]}").` };
  }
  const engine = args.engine ?? "jaccard";
  if (engine !== "jaccard" && engine !== "semantic") {
    return { error: `--engine must be "jaccard" or "semantic" (got "${args.engine}").` };
  }
  const threshold = args.threshold === undefined ? (engine === "semantic" ? 0.3 : 0.34) : Number(args.threshold);
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
    return { error: `--threshold must be a number between 0 and 1 (got "${args.threshold}").` };
  }
  return { options: { minOccurrences, minAuthors, engine, threshold } };
}


// Stages that live in their own modules (and keep their own --help).
const DELEGATED = {
  fetch: "./commands/fetch.mjs",
  generate: "./commands/generate.mjs",
  mcp: "./commands/mcp.mjs",
  export: "./commands/export.mjs",
};

// Returns an exit code, or null when a long-running subcommand (mcp)
// should keep the process alive.
async function main(argv) {
  // Dispatch stages before parsing: their flags (e.g. generate --demo) are
  // not ours. The stage may follow leading flags: "--dry-run generate x.json".
  const first = argv.findIndex((a) => !a.startsWith("-"));
  if (first !== -1 && Object.hasOwn(DELEGATED, argv[first])) {
    const { main: runStage } = await import(DELEGATED[argv[first]]);
    return runStage(argv.filter((_, i) => i !== first));
  }

  const spec = {
    booleans: ["help", "version", "llm", "force", "dry-run", "no-cache", "refresh", "save", "json", "demo", "all", "single-reviewer", "raw"],
    aliases: { h: "help", v: "version", o: "owner", r: "repo", t: "target", f: "force", m: "months" },
  };
  // Flags that take a value; anything else is an unknown option.
  const values = [
    "owner", "repo", "target", "months", "format", "min-occurrences", "min-authors", "engine", "threshold",
    "api-key", "token", "preset", "time-decay-half-life", "limit", "discard", "config", "base", "paths",
    "generator", "query", "reason", "title", "urls", "host", "api-url", "budget", "max-chars", "provider",
  ];
  let args;
  try {
    // Loose first: a stage after a flag ("--target x generate --summary")
    // takes flags we don't know; strict once we know it's ours.
    args = parseArgs(argv, spec);
    if (!Object.hasOwn(DELEGATED, args._[0] ?? "")) args = parseArgs(argv, { ...spec, values });
  } catch (e) {
    if (e instanceof ArgsError) {
      process.stderr.write(`Error: ${e.message} Run \`reviewlore --help\` for the options.\n`);
      return 1;
    }
    throw e;
  }
  // What the user typed, before a config file or preset fills in more.
  // `candidates` only honours these: a preset's min-occurrences would strip
  // the single comments the plugin skill needs to see.
  const cliArgs = { ...args };

  // A stage after a flag with a value ("--target x generate …").
  if (Object.hasOwn(DELEGATED, args._[0] ?? "")) {
    const { main: runStage } = await import(DELEGATED[args._[0]]);
    return runStage(argv.filter((a) => a !== args._[0]));
  }

  if (args.help || args._[0] === "help") { process.stdout.write(HELP); return 0; }
  if (args.version) { process.stdout.write(`${VERSION}\n`); return 0; }

  // Subcommands: "init" (wizard), "publish-corpus", "run" (default).
  const subcommand = args._[0] ?? "run";
  if (subcommand === "init") {
    try {
      await runInitWizard({ targetHint: args.target ?? "." });
      return 0;
    } catch (e) {
      process.stderr.write(`Error: ${e.message}\n`);
      return 1;
    }
  }
  if (subcommand === "publish-corpus") {
    return await runPublishCorpus(args);
  }
  if (subcommand === "doctor") {
    const report = runDoctor({ cwd: args.target ? resolve(args.target) : process.cwd() });
    process.stdout.write(args.json ? `${JSON.stringify(report, null, 2)}\n` : renderDoctor(report));
    return report.ok ? 0 : 1;
  }
  if (subcommand === "precedents") return runPrecedents(args);
  if (subcommand === "rules") return runRules(args);
  if (subcommand === "candidates" && args.discard !== undefined) {
    if (typeof args.discard !== "string") {
      process.stderr.write("Error: --discard needs the path `candidates --save` printed.\n");
      return 1;
    }
    try {
      discardScratch(args.discard);
      return 0;
    } catch (e) {
      process.stderr.write(`Error: ${e.message}\n`);
      return 1;
    }
  }
  if (subcommand === "candidates" && args.demo) {
    // Bundled snapshot: no repo, no token, no network.
    const json = readFileSync(join(PACKAGE_ROOT, "lib", "fixtures", "demo-candidates.json"), "utf-8");
    process.stdout.write(args.save ? `${saveScratch(json)}\n` : json);
    process.stderr.write("Demo: vitest-dev/vitest's public review history (reviewer names pseudonymised).\n");
    return 0;
  }
  if (subcommand !== "run" && subcommand !== "candidates") {
    process.stderr.write(
      `Error: unknown command "${subcommand}". Commands: run, candidates, fetch, generate, mcp, export, init, publish-corpus, doctor, precedents, rules.\n`,
    );
    return 1;
  }

  // Load config file (if present) and apply BEFORE preset expansion.
  // Precedence: explicit CLI flag > config file > preset > built-in default.
  // applyConfig only fills unset values, so a CLI --preset still wins over
  // the config's preset field; the config's preset only kicks in when no
  // CLI flag set one. Preset expansion has to run AFTER this, otherwise a
  // wizard-saved `preset: "team-of-50"` never gets expanded into per-flag
  // defaults like min-occurrences / engine.
  const cfgPath = findConfigPath({
    explicit: args.config,
    targetDir: args.target,
  });
  if (cfgPath) {
    try {
      const cfg = loadConfig(cfgPath);
      applyConfig(args, cfg);
      process.stderr.write(`Config: ${cfgPath}\n`);
    } catch (e) {
      process.stderr.write(`Warning: ${e.message}\n`);
    }
  }

  try {
    applyPreset(args, args.preset);
  } catch (e) {
    process.stderr.write(`Error: ${e.message}\n`);
    return 1;
  }
  if (args.preset) process.stderr.write(`Preset: ${args.preset}\n`);

  // Default --target to the git toplevel when cwd is anywhere inside a git
  // working tree (root or any subdirectory — monorepos commonly run the tool
  // from `packages/<x>/`). Falling back to cwd keeps `--dry-run` working in
  // non-git scratch dirs.
  let target = args.target;
  if (!target) {
    const toplevel = findGitToplevel(process.cwd());
    if (toplevel) {
      target = toplevel;
    } else if (!args["dry-run"]) {
      process.stderr.write("Error: --target is required (or run from inside a git-cloned project, or pass --dry-run).\n");
      return 1;
    }
  }

  // Fill in --owner / --repo from `git remote get-url origin` when not
  // provided. Lets users run `reviewlore run` inside any git-cloned
  // project with zero arguments.
  const where = resolveRepo({
    owner: args.owner, repo: args.repo, host: args.host, apiUrl: args["api-url"], provider: args.provider,
    dir: target ? resolve(target) : process.cwd(),
  });
  if (where.error) {
    process.stderr.write(`Error: ${where.error}\n`);
    return 1;
  }
  const { owner, repo, host = "github.com", provider = "github" } = where;
  if (where.detected && !args.owner && !args.repo) {
    process.stderr.write(`Detected ${repoLabel(owner, repo, host)} from git origin.\n`);
  }
  if (!owner || !repo) {
    process.stderr.write(
      "Error: --owner and --repo are required (or run from inside a git-cloned project so they can be auto-detected from `git remote`).\n" +
      "Run `reviewlore --help` for usage.\n",
    );
    return 1;
  }

  // Strict parsing: Number() returns NaN for "6m"-style trailing junk, unlike
  // parseInt which would lenient-parse and silently accept it.
  const monthsBack = Number(args.months ?? 6);
  if (!Number.isInteger(monthsBack) || monthsBack <= 0) {
    process.stderr.write(`Error: --months must be a positive integer (got "${args.months}").\n`);
    return 1;
  }
  if (target) {
    const resolved = resolve(target);
    if (!existsSync(resolved) || !statSync(resolved).isDirectory()) {
      process.stderr.write(`Error: --target must be an existing directory: ${resolved}\n`);
      return 1;
    }
  }

  // `candidates` writes nothing, so output formats don't apply to it.
  const formatArg = args.format ?? "claude";
  let formatNames = [];
  if (subcommand === "run") {
    try {
      formatNames = resolveFormats(formatArg, target ? resolve(target) : process.cwd());
    } catch (e) {
      process.stderr.write(`Error: ${e.message}\n`);
      return 1;
    }
    if (formatArg === "auto") {
      process.stderr.write(`Auto-detected format(s): ${formatNames.join(", ")}\n`);
    }
  }
  const renderers = formatNames.map(getRenderer);

  // ---- Phase 1: get the corpus ----
  // Three sources, in priority order:
  //   1. In-repo corpus file (zero token, zero network)
  //   2. ~/.reviewlore/<owner>__<repo>.json incremental cache (token to top up)
  //   3. Full fetch from GitHub (token required)
  let data;
  const resolvedTarget = target ? resolve(target) : process.cwd();
  let corpusOnDisk = corpusInfo(resolvedTarget);
  if (corpusOnDisk?.error) {
    process.stderr.write(
      `Ignoring ${corpusOnDisk.path}: it isn't valid JSON (unresolved merge conflict?). ` +
      "Re-publish it with `reviewlore publish-corpus --force`.\n",
    );
    corpusOnDisk = null;
  }
  // A corpus without `host` is from github.com (written before 0.3).
  const corpusRepo = corpusOnDisk?.meta?.owner && repoLabel(corpusOnDisk.meta.owner, corpusOnDisk.meta.repo, corpusOnDisk.meta.host ?? "github.com");
  if (corpusRepo && corpusRepo !== repoLabel(owner, repo, host)) {
    process.stderr.write(`Ignoring ${corpusOnDisk.path}: it holds ${corpusRepo}, not ${repoLabel(owner, repo, host)}.\n`);
    corpusOnDisk = null;
  }
  if (corpusOnDisk && !args.refresh) {
    process.stderr.write(
      `[1/2] Using in-repo corpus: ${corpusOnDisk.path}\n` +
      `      (${(corpusOnDisk.meta.source_totals ?? corpusOnDisk.totals).total ?? "?"} comments, ${corpusOnDisk.sizeKb} KB, ${Math.round(corpusOnDisk.ageDays)} days old)\n` +
      `      Pass --refresh to ignore the corpus and re-fetch from GitHub.\n\n`,
    );
    data = loadCorpus(resolvedTarget);

    // Maintainer top-up: when a token AND a home cache both exist, do an
    // incremental fetch and merge it into the cache so a subsequent
    // `publish-corpus` reflects the latest GitHub state. Without this,
    // the documented `run` then `publish-corpus` refresh workflow is a
    // silent no-op: `run` reads the corpus, never touches the cache, and
    // `publish-corpus` re-publishes whatever the cache had last month.
    // Teammates with no token take the original zero-network path.
    const useCache = !args["no-cache"];
    // Best effort: without dependencies or a token, just use the corpus.
    const fetcher = useCache && loadCache(owner, repo, host) ? await openFetcher(where, { token: args.token }) : {};
    if (fetcher.fetch) {
      try {
        let since = sinceFromMonths(monthsBack);
        const inc = incrementalSince(owner, repo, since, host);
        if (inc && inc > since) since = inc;
        process.stderr.write(
          `Topping up local cache from ${host} (since ${since.toISOString()}) so the next \`publish-corpus\` is fresh...\n`,
        );
        const fresh = await fetcher.fetch({
          since, monthsBack, out: process.stderr, mode: process.env.REVIEWLORE_FETCH, concurrency: fetchConcurrency(), checkpoint: true,
        });
        const path = mergeIntoCache(owner, repo, fresh, host);
        process.stderr.write(`📦 Cache refreshed: ${path}\n`);
        const merged = loadCache(owner, repo, host);
        if (merged) data = merged;
      } catch (err) {
        process.stderr.write(
          `⚠️  Cache top-up failed (${explainGitHubError(err, { owner, repo, host, provider })}); continuing with the on-disk corpus.\n`,
        );
      }
    }
  } else {
    const fetcher = await openFetcher(where, { token: args.token });
    if (fetcher.error) {
      process.stderr.write(`Error: ${fetcher.error}\n`);
      if (!corpusOnDisk) {
        process.stderr.write(
          `\nHint: if a teammate has run the toolkit before, ask them to run\n` +
          `      \`reviewlore publish-corpus\` and commit the resulting\n` +
          `      ${CORPUS_FILENAME} — you can then run with no token.\n`,
        );
      }
      return 1;
    }

    const useCache = !args["no-cache"];
    let since = sinceFromMonths(monthsBack);
    if (useCache) {
      const inc = incrementalSince(owner, repo, since, host);
      if (inc && inc > since) {
        process.stderr.write(`Cache hit: fetching incrementally since ${inc.toISOString()}.\n`);
        since = inc;
      }
    }

    process.stderr.write(`\n[1/2] Fetching ${repoLabel(owner, repo, host)} (range: ${since.toISOString()} → now)...\n\n`);
    try {
      data = await fetcher.fetch({
        since, monthsBack, out: process.stderr, mode: process.env.REVIEWLORE_FETCH, concurrency: fetchConcurrency(), checkpoint: useCache,
      });
      if (useCache) {
        const path = mergeIntoCache(owner, repo, data, host);
        process.stderr.write(`📦 Cache: ${path}\n`);
        // An incremental fetch only returned what's new since last time;
        // work from the merged cache, cut to the requested window.
        data = filterSince(loadCache(owner, repo, host) ?? data, sinceFromMonths(monthsBack));
      }
      const t = data.meta.totals;
      process.stderr.write(`Fetched: ${t.total} total comments (${t.issue_comments} issue / ${t.review_comments} review / ${t.review_submissions} submissions).\n`);
    } catch (err) {
      process.stderr.write(`\n❌ Fetch failed: ${explainGitHubError(err, { owner, repo, host, provider })}\n`);
      return 1;
    }
  }

  // A committed corpus (or the cache top-up above) can span more history
  // than asked for: an explicit --months (flag, config or preset) applies.
  const explicitMonths = subcommand === "candidates" ? cliArgs.months : args.months;
  if (corpusOnDisk && !args.refresh && explicitMonths !== undefined) {
    data = filterSince(data, sinceFromMonths(monthsBack));
  }

  if (subcommand === "candidates" && args.raw) return emitRaw(data, args);
  if (subcommand === "candidates") {
    return emitCandidates(data, resolvedTarget, {
      ...args,
      "min-occurrences": cliArgs["min-occurrences"],
      "min-authors": cliArgs["min-authors"],
    });
  }

  // ---- Phase 2: cluster + write ----
  process.stderr.write(`\n[2/2] Extracting recurring patterns...\n`);
  // Single-maintainer mode: one reviewer on 3+ PRs. Flags typed on the
  // command line still win; a preset or config file doesn't.
  if (args["single-reviewer"]) {
    args["min-authors"] = cliArgs["min-authors"] ?? 1;
    args["min-occurrences"] = cliArgs["min-occurrences"] ?? 3;
  }
  const { options: clusterOpts, error: optError } = clusterOptions(args, { minOccurrences: 3, minAuthors: 2 });
  if (optError) {
    process.stderr.write(`Error: ${optError}\n`);
    return 1;
  }
  const { minOccurrences, minAuthors } = clusterOpts;
  const halfLife = parseFloat(args["time-decay-half-life"] ?? "0");
  const candidates = extractCandidates(data, {
    signals: { timeDecayHalfLifeMonths: Number.isFinite(halfLife) ? halfLife : 0 },
  });
  const clusters = buildClusters(candidates, { engine: clusterOpts.engine, threshold: clusterOpts.threshold });
  const kept = filterClusters(clusters, { minOccurrences, minAuthors });

  process.stderr.write(
    `Extracted ${candidates.length} candidates → ${clusters.length} clusters → ${kept.length} kept (>= ${minOccurrences} occurrences, >= ${minAuthors} authors).\n\n`,
  );

  if (kept.length === 0) {
    const bar = args["single-reviewer"] ? `${minOccurrences}+ PRs from 1 reviewer` : `${minOccurrences}+ (reviewer, PR) pairs from ${minAuthors}+ reviewers`;
    process.stderr.write(`No rules: nothing reached the bar (${bar}).\n${explainEmptyResult(historyStats(data), { months: monthsBack, singleReviewer: Boolean(args["single-reviewer"]) })}\n`);
    return 0;
  }

  process.stdout.write(renderSummary(kept, data.meta));

  if (args["dry-run"]) {
    process.stderr.write("(dry-run — no files written)\n");
    return 0;
  }

  let synth = null;
  if (args.llm) {
    process.stderr.write(`Synthesising ${kept.length} rules via Claude...\n`);
    synth = await synthesiseAll(kept, { apiKey: args["api-key"] });
    const failed = synth.filter((s) => s?._error);
    if (failed.length) {
      process.stderr.write(
        `⚠️  ${failed.length} of ${kept.length} rules fell back to heuristic text: ${failed[0]._error}\n`,
      );
    }
  }

  // Diff against previous run's state (if any) BEFORE writing — so users
  // who run `reviewlore run` monthly actually see the
  // added/strengthened/weakened/gone breakdown advertised in the README.
  const resolvedTargetForState = resolve(target);
  const previousState = loadPreviousState(resolvedTargetForState);
  const diffReport = reportDiffSinceLastRun(previousState, kept);
  if (diffReport) process.stderr.write(`\n${diffReport}`);

  const written = [];
  const skipped = [];
  for (const r of renderers) {
    const result = r.write(kept, {
      targetDir: resolvedTargetForState,
      force: Boolean(args.force),
      synth,
      meta: data.meta,
    });
    for (const w of result.written) written.push({ ...w, format: r.name });
    for (const s of result.skipped) skipped.push({ ...s, format: r.name });
  }

  // Persist state for the next run's diff.
  writeCurrentState(resolvedTargetForState, kept);

  // Track the rule files this run wrote, so `rules status` can check them later.
  const ruleNames = written.filter((w) => w.format === "claude").map((w) => w.path.split(/[\\/]/).pop());
  if (ruleNames.length) {
    recordFiles(resolvedTargetForState, ruleNames, {
      generator: synth ? "heuristic+llm" : "heuristic",
      byUrl: urlDates(data),
      ctx: { owner, repo, source: corpusOnDisk && !args.refresh ? "corpus" : "cache", fetchedAt: data.meta?.last_fetched_at ?? data.meta?.fetched_at ?? null },
    });
  }

  process.stderr.write(`\n✅ Wrote ${written.length} file(s) [format(s): ${formatNames.join(", ")}] into ${resolvedTargetForState}\n`);
  for (const w of written) process.stderr.write(`   - [${w.format}] ${w.path}\n`);
  if (skipped.length > 0) {
    process.stderr.write(
      `\n⚠️  Skipped ${skipped.length} existing file(s) (pass --force to overwrite):\n`,
    );
    for (const s of skipped) process.stderr.write(`   - ${s.path}\n`);
  }
  process.stderr.write(
    `\nNext: review the generated file(s), delete any false positives, commit the rest.\n`,
  );
  return 0;
}

// ---- candidates subcommand ---------------------------------------------
//
// Prints review feedback as JSON for a model to synthesise rules from.
// Thresholds are deliberately loose (singletons included): word-overlap
// clustering misses paraphrases ("add a changeset" vs "please include a
// changeset file"), and a model reading the quotes can merge those. The
// precision gates (≥ 2 PRs, ≥ 2 reviewers per rule) are applied by the
// consumer — see skills/learn-from-reviews/SKILL.md.

function emitCandidates(data, targetDir, args) {
  const { options, error } = clusterOptions(args, { minOccurrences: 1, minAuthors: 1 });
  const limit = Number(args.limit ?? 150);
  if (error || !Number.isInteger(limit) || limit < 1) {
    process.stderr.write(`Error: ${error ?? `--limit must be a positive integer (got "${args.limit}").`}\n`);
    return 1;
  }
  const candidates = extractCandidates(data);
  const clusters = filterClusters(
    buildClusters(candidates, { engine: options.engine, threshold: options.threshold }),
    { minOccurrences: options.minOccurrences, minAuthors: options.minAuthors },
  );
  const shown = clusters.slice(0, limit);
  const history = historyStats(data);
  const out = {
    repo: `${data.meta?.owner}/${data.meta?.repo}`,
    since: data.meta?.since ?? null,
    stats: {
      // As fetched: a slim committed corpus keeps only the comments that matter.
      comments: (data.meta?.source_totals ?? data.meta?.totals)?.total ?? null,
      candidates: candidates.length,
      clusters: clusters.length,
      shown: shown.length,
    },
    // How much human review there is, and what the repo already says:
    // the skill warns on thin history and checks rules against these.
    history,
    // Word-overlap clusters never reach the bar: say why and what to try.
    // (The skill may still merge paraphrases into a rule, so this is a hint.)
    ...(shown.some((c) => c.distinctPRs >= 2 && c.distinctAuthors >= 2)
      ? {}
      : { diagnosis: diagnoseEmpty(history, { months: Number(args.months ?? 6) || 6 }) }),
    existing_instructions: findInstructionFiles(targetDir),
    clusters: shown.map((c, i) => ({
      id: `c${i + 1}`,
      kind: c.kind,
      label: c.label,
      occurrences: c.occurrences,
      reviewers: c.distinctAuthors,
      prs: c.distinctPRs,
      globs: pathGlobs(c.paths),
      last_seen: c.lastSeen,
      quotes: pickExamples(c.items, 5).map((q) => ({
        text: q.sentence, author: q.author, pr: q.pr, url: q.url, path: q.path ?? undefined,
      })),
    })),
  };
  // One cluster per line: readable, and far fewer tokens than pretty-printing.
  const { clusters: list, ...head } = out;
  const json = `${JSON.stringify(head).slice(0, -1)},"clusters":[\n${list.map((c) => JSON.stringify(c)).join(",\n")}\n]}\n`;
  // --save: a private temp file, so the skill needs no shell redirection.
  process.stdout.write(args.save ? `${saveScratch(json)}\n` : json);
  process.stderr.write(
    `${candidates.length} candidate sentences → ${clusters.length} clusters; printed ${shown.length}.\n`,
  );
  return 0;
}

// ---- precedents subcommand ----------------------------------------------
//
// Offline and read-only. Exits 0 for anything expected (no base branch, no
// data, not a repo) with a `status` and `hint`, so the skill can explain;
// 1 only for bad flags.

function writeJsonLines(out, keys) {
  const head = Object.fromEntries(Object.entries(out).filter(([k]) => !keys.includes(k)));
  const arrays = keys.filter((k) => out[k]).map((k) =>
    `"${k}":[${out[k].length ? `\n${out[k].map((x) => JSON.stringify(x)).join(",\n")}\n` : ""}]`);
  process.stdout.write(`${JSON.stringify(head).slice(0, -1)}${arrays.length ? `,${arrays.join(",\n")}` : ""}}\n`);
}

async function runPrecedents(args) {
  const limit = Number(args.limit ?? 8);
  const months = Number(args.months ?? 12);
  if (!Number.isInteger(limit) || limit < 1 || !Number.isFinite(months) || months <= 0) {
    process.stderr.write("Error: --limit must be a positive integer and --months a positive number.\n");
    return 1;
  }
  if ((args.owner === undefined) !== (args.repo === undefined)) {
    process.stderr.write("Error: pass both --owner and --repo, or neither.\n");
    return 1;
  }
  const start = args.target ? resolve(args.target) : process.cwd();
  const dir = findGitToplevel(start);
  const emit = (out) => {
    writeJsonLines(out, ["changed", "rules", "recurring", "file_history"]);
    return 0;
  };
  if (!dir) return emit({ status: "not-a-repo", hint: `${start} is not inside a git repository.` });

  let base = null;
  let mergeBase = null;
  let changed;
  if (typeof args.paths === "string" && args.paths.trim()) {
    changed = [...new Set(args.paths.split(",").map((p) => p.trim().replace(/^\.\//, "")).filter(Boolean))].sort().map((path) => ({ path, status: "M" }));
  } else {
    base = detectBaseRef(dir, typeof args.base === "string" && args.base.trim() ? args.base.trim() : undefined);
    if (!base) {
      return emit({
        status: "no-base",
        hint: args.base ? `"${args.base}" isn't a branch or commit here.` : "Couldn't find a base branch (origin/HEAD, origin/main, origin/master, main, master); pass --base <ref>.",
      });
    }
    const diff = changedPaths(dir, base);
    if (!diff) return emit({ status: "git-error", hint: `Couldn't compare HEAD with ${base}.` });
    ({ mergeBase, changed } = diff);
  }

  const ctx = resolveContext({ owner: args.owner, repo: args.repo }, { dir });
  if (ctx.error) return emit({ status: "no-repo", hint: ctx.error, changed });
  const index = await loadIndex(ctx);
  const found = precedentsFor(index, changed, { limit, months });
  const ageDays = ctx.fetchedAt ? Math.max(0, Math.round((Date.now() - Date.parse(ctx.fetchedAt)) / 86_400_000)) : null;
  return emit({
    status: ctx.source ? "ok" : "no-data",
    ...(ctx.source ? {} : { hint: `No review history for ${ctx.owner}/${ctx.repo} yet: only rule files were checked. Run /reviewlore:learn-from-reviews or \`reviewlore fetch --cache\`.` }),
    repo: `${ctx.owner}/${ctx.repo}`,
    base,
    merge_base: mergeBase,
    data: { source: ctx.source, age_days: ageDays },
    stats: found.stats,
    changed,
    rules: found.rules,
    recurring: found.recurring,
    file_history: found.file_history,
  });
}

// ---- rules subcommand -----------------------------------------------------
//
// Keeps .claude/reviewlore-rules.json in step with the generated rule files
// (docs/plans/10-keeping-rules-fresh.md). Offline. Changes only the manifest:
// rule files are written and deleted by the skill (or `run`), with approval.

const RULES_HELP = `reviewlore rules <action>

  status [--json] [--months 6]       report each generated rule: still supported
                                      by recent review, paths still present,
                                      edited, deleted (always exits 0)
  record <file…> | --all              record rule files as written now
          [--generator learn-from-reviews|heuristic|heuristic+llm] [--query "words"]
  dismiss <file…> [--reason r]        forget rules whose files were deleted, and
                                      don't propose them again
  dismiss --title "…" --urls a,b      remember a declined proposal
  retire <file…>                      mark rules retired (delete the file first)

Files are names in .claude/rules/ (e.g. pr-feedback-add-a-changeset.md).
`;

async function runRules(args) {
  const action = args._[1];
  const names = args._.slice(2).map((f) => f.split(/[\\/]/).pop());
  if (!action || !["status", "record", "dismiss", "retire"].includes(action)) {
    process.stderr.write(action ? `Error: unknown action "${action}".\n\n${RULES_HELP}` : RULES_HELP);
    return action ? 1 : 0;
  }
  if ((args.owner === undefined) !== (args.repo === undefined)) {
    process.stderr.write("Error: pass both --owner and --repo, or neither.\n");
    return 1;
  }
  const start = args.target ? resolve(args.target) : process.cwd();
  const dir = findGitToplevel(start) ?? start;
  const ctx = resolveContext({ owner: args.owner, repo: args.repo }, { dir });
  const rulesDir = join(dir, ".claude", "rules");
  const today = new Date().toISOString().slice(0, 10);

  if (action === "status") {
    const months = Number(args.months ?? 6);
    if (!Number.isFinite(months) || months <= 0) {
      process.stderr.write("Error: --months must be a positive number.\n");
      return 1;
    }
    const manifest = loadManifest(dir) ?? emptyManifest();
    const index = !ctx.error && ctx.source ? await loadIndex(ctx) : null;
    const status = ruleStatus({ targetDir: dir, manifest, index, tracked: trackedFiles(dir), months });
    const ageDays = ctx.fetchedAt ? Math.max(0, Math.round((Date.now() - Date.parse(ctx.fetchedAt)) / 86_400_000)) : null;
    const repoName = ctx.error ? manifest.repo ?? "this repository" : `${ctx.owner}/${ctx.repo}`;
    process.stdout.write(args.json
      ? `${JSON.stringify({ repo: repoName, data: { source: ctx.source ?? null, age_days: ageDays }, months, ...status }, null, 2)}\n`
      : renderStatus(status, { repo: repoName, source: ctx.source, ageDays, months }));
    return 0;
  }

  if (action === "record") {
    if (args.generator !== undefined && !GENERATORS.includes(args.generator)) {
      process.stderr.write(`Error: --generator must be one of ${GENERATORS.join(", ")}.\n`);
      return 1;
    }
    const targets = args.all
      ? (existsSync(rulesDir) ? readdirSync(rulesDir).filter((f) => /^pr-feedback-.+\.md$/.test(f)).sort() : [])
      : names;
    if (!targets.length) {
      process.stderr.write("Error: name the rule files to record, or pass --all.\n");
      return 1;
    }
    const index = !ctx.error && ctx.source ? await loadIndex(ctx) : null;
    const byUrl = new Map((index?.comments ?? []).map((c) => [c.url, c]));
    const { recorded, skipped } = recordFiles(dir, targets, {
      generator: args.generator, query: typeof args.query === "string" ? args.query : undefined, byUrl, ctx,
    });
    process.stderr.write(`Recorded ${recorded.length} rule(s) in ${MANIFEST_FILE}.\n`);
    if (skipped.length && !args.all) {
      process.stderr.write(`Not reviewlore rules (or missing): ${skipped.join(", ")}\n`);
      return 1;
    }
    return 0;
  }

  const manifest = loadManifest(dir) ?? emptyManifest(ctx.error ? null : `${ctx.owner}/${ctx.repo}`);
  if (action === "dismiss") {
    if (typeof args.title === "string") {
      const urls = typeof args.urls === "string" ? args.urls.split(",").map((u) => u.trim()).filter(Boolean) : [];
      manifest.dismissed.push({ title: args.title, evidence: urls, at: today, reason: typeof args.reason === "string" ? args.reason : "declined" });
    } else {
      for (const name of names) {
        const entry = manifest.rules[name];
        if (!entry) {
          process.stderr.write(`Error: ${name} isn't recorded in ${MANIFEST_FILE}.\n`);
          return 1;
        }
        if (existsSync(join(rulesDir, name))) {
          process.stderr.write(`Error: ${name} still exists; delete it first (or use \`rules retire\`).\n`);
          return 1;
        }
        manifest.dismissed.push({ title: entry.title ?? name, evidence: (entry.evidence ?? []).map((e) => e.url), at: today, reason: typeof args.reason === "string" ? args.reason : "deleted-by-user" });
        delete manifest.rules[name];
      }
    }
    manifest.dismissed.sort((a, b) => (a.at + a.title < b.at + b.title ? -1 : 1));
    saveManifest(dir, manifest);
    return 0;
  }

  // retire
  for (const name of names) {
    if (!manifest.rules[name]) {
      process.stderr.write(`Error: ${name} isn't recorded in ${MANIFEST_FILE}.\n`);
      return 1;
    }
    if (existsSync(join(rulesDir, name))) {
      process.stderr.write(`Error: delete .claude/rules/${name} first (git history keeps it), then retire it.\n`);
      return 1;
    }
    manifest.rules[name] = { ...manifest.rules[name], status: "retired", retired: today };
  }
  saveManifest(dir, manifest);
  return 0;
}

// ---- candidates --raw ------------------------------------------------------
//
// Whole human comments in any language, for Claude to read when phrase
// matching finds too little (docs/plans/07). One header line, then one
// comment per line (JSONL).

function emitRaw(data, args) {
  const budget = Number(args.budget ?? 60000);
  const maxChars = Number(args["max-chars"] ?? 1200);
  if (!Number.isInteger(budget) || budget < 1000 || !Number.isInteger(maxChars) || maxChars < 50) {
    process.stderr.write("Error: --budget must be an integer of at least 1000 (tokens) and --max-chars at least 50.\n");
    return 1;
  }
  const { stats, rows, url_base: urlBase } = rawComments(data, { budget, maxChars });
  const head = {
    repo: `${data.meta?.owner}/${data.meta?.repo}`,
    ...(data.meta?.host ? { host: data.meta.host } : {}),
    since: data.meta?.since ?? null,
    mode: "raw",
    url_base: urlBase,
    history: historyStats(data),
    stats,
  };
  const text = `${[head, ...rows].map((x) => JSON.stringify(x)).join("\n")}\n`;
  process.stdout.write(args.save ? `${saveScratch(text)}\n` : text);
  process.stderr.write(
    `${stats.survivors} review comments after filtering (≈ ${(stats.est_tokens / 1000).toFixed(1)}k tokens shown); printed ${stats.shown}` +
    `${stats.dropped_for_budget ? `, ${stats.dropped_for_budget} left out by --budget ${budget}` : ""}.\n`,
  );
  return 0;
}

// ---- publish-corpus subcommand ----------------------------------------

async function runPublishCorpus(args) {
  // owner/repo: from --flags, then from git remote of target (or cwd).
  const targetDir = resolve(args.target ?? ".");
  if (!existsSync(targetDir) || !statSync(targetDir).isDirectory()) {
    process.stderr.write(`Error: --target must be an existing directory: ${targetDir}\n`);
    return 1;
  }
  const where = resolveRepo({ owner: args.owner, repo: args.repo, host: args.host, apiUrl: args["api-url"], provider: args.provider, dir: targetDir });
  if (where.error) {
    process.stderr.write(`Error: ${where.error}\n`);
    return 1;
  }
  const { owner, repo, host = "github.com" } = where;
  if (!owner || !repo) {
    process.stderr.write(
      "Error: --owner and --repo are required for publish-corpus (auto-detection from git remote failed).\n",
    );
    return 1;
  }

  // Refuse to clobber an existing corpus unless --force.
  const path = corpusPath(targetDir);
  if (existsSync(path) && !args.force) {
    const info = corpusInfo(targetDir);
    process.stderr.write(
      `Refusing to overwrite ${path}\n  (${info.totals?.total ?? "?"} comments, ${info.sizeKb} KB, ${Math.round(info.ageDays)} days old).\n` +
      `Pass --force to overwrite, or delete the file first.\n`,
    );
    return 1;
  }

  try {
    const result = publishCorpus({ owner, repo, host, targetDir });
    process.stderr.write(
      (result.unchanged ? `✅ Corpus unchanged (no new comments) — left ${result.path} as it was\n` : `✅ Published corpus to ${result.path}\n`) +
      `   ${result.totals?.total ?? "?"} comments (${result.totals?.issue_comments ?? 0} issue / ${result.totals?.review_comments ?? 0} review / ${result.totals?.review_submissions ?? 0} submissions), ${result.sizeKb} KB` +
      ` (cache: ${result.sourceSizeKb} KB; left out ${result.dropped.noise} bot / short / praise, ${result.dropped.pr_author} PR-author and ${result.dropped.plain_issue} plain-issue comments, which never become rules).\n`,
    );
    if (Array.isArray(result.warnings) && result.warnings.length > 0) {
      const sample = result.warnings.slice(0, 5).map(
        (w) => `     - ${w.html_url ?? "(unknown URL)"} [${w.labels.join(", ")}]`,
      ).join("\n");
      const extra = result.warnings.length > 5
        ? `\n     ... and ${result.warnings.length - 5} more`
        : "";
      process.stderr.write(
        `\n⚠️  Redacted credential-shaped strings in ${result.warnings.length} comment(s):\n` +
        `${sample}${extra}\n` +
        `   The matched substrings were replaced with [REDACTED] in the corpus.\n` +
        `   Review ${CORPUS_FILENAME} and the linked GitHub comments before\n` +
        `   committing — rotate any leaked credentials and consider editing\n` +
        `   the original comments on GitHub.\n`,
      );
    }
    process.stderr.write(
      `\nNext steps:\n` +
      `   1. Review ${CORPUS_FILENAME} for any sensitive content before committing.\n` +
      `   2. git add ${CORPUS_FILENAME}\n` +
      `   3. git commit -m "chore: refresh PR-comments corpus"\n\n` +
      `Once committed, every teammate's \`reviewlore run\` will use\n` +
      `this corpus and won't need a GitHub token. Re-publish whenever you want\n` +
      `to refresh — typically monthly, or wire up the scheduled GitHub Action\n` +
      `(see examples/github-action/ in the toolkit repo).\n`,
    );
    return 0;
  } catch (e) {
    process.stderr.write(`Error: ${e.message}\n`);
    return 1;
  }
}

const code = await main(process.argv.slice(2));
// Writes to a pipe are asynchronous on macOS: exiting straight away cuts
// `candidates | jq` off at 64 KB. Exit once both streams have flushed.
if (code !== null) {
  process.stdout.write("", () => process.stderr.write("", () => process.exit(code)));
}
