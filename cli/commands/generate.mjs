import { readFileSync, writeFileSync, existsSync, statSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, ArgsError } from "../../lib/args.mjs";
import { extractCandidates, buildClusters, filterClusters } from "../../lib/extract.mjs";
import { renderSummary } from "../../lib/skill-writer.mjs";
import { getRenderer, resolveFormats, rendererSummary } from "../../lib/renderers/index.mjs";
import { synthesiseAll } from "../../lib/llm.mjs";
import { loadPreviousState, reportDiffSinceLastRun, writeCurrentState } from "../../lib/diff.mjs";
import { applyPreset, presetSummary } from "../../lib/presets.mjs";
import { recordFiles, urlDates } from "../../lib/rules-manifest.mjs";

const VERSION = "0.3.0";

const HELP = `reviewlore generate v${VERSION}

Reads a JSON file produced by \`reviewlore fetch\` and writes rule
files (Claude Code .claude/rules/*.md by default) into a target repository,
based on recurring reviewer feedback. Heuristic by default; pass --llm for
Claude API-synthesised rules.

Usage:
  reviewlore generate <input.json> --target <repo-path> [options]

Options:
  --target <path>            Target repo where .claude/rules/ should be written (required)
  --min-occurrences <n>      Minimum number of comments per cluster (default: 3)
  --min-authors <n>          Minimum distinct authors per cluster (default: 2)
  --threshold <n>            Similarity threshold for clustering (0–1; default depends on --engine)
  --engine <name>            Clustering engine: jaccard | semantic (TF-IDF cosine). Default: jaccard
  --dry-run                  Print the summary of rules that would be written; write nothing
  --summary                  Also print that summary (of the kept clusters) when writing
  --force / -f               Overwrite existing pr-feedback-*.md files (default: skip)
  --llm                      Use Claude to synthesise each cluster into a polished rule
                             (requires ANTHROPIC_API_KEY; install @anthropic-ai/sdk)
  --api-key <key>            Anthropic API key (falls back to ANTHROPIC_API_KEY env)
  --format <name(s)>         Output format. Default: claude. Supported:
${rendererSummary()}
                             Also: 'auto' (detect from target's existing files),
                             'all' (every renderer), or comma-separated list
                             (e.g. claude,cursor,html).
  --demo                     Run against a bundled fixture (no GitHub token,
                             no input file, no target). Prints the rules
                             that would be generated to stdout. Great for
                             trying the tool out in 5 seconds.
  --preset <name>            Tuning profile. Sets sensible defaults for
                             min-occurrences / min-authors / engine /
                             time-decay-half-life. Available:
${presetSummary()}
                             Explicit flags override preset values.
  --time-decay-half-life <n> Month half-life for recency weighting (default: 0
                             = no decay). Older comments count less.
  --version                  Print version and exit
  --help                     Show this help and exit

Examples:
  reviewlore generate pr-comments-react-12345.json --target ~/code/react
  reviewlore generate out.json --target . --min-occurrences 5 --min-authors 3
  reviewlore generate out.json --target . --dry-run --summary
`;

export async function main(argv) {
  let args;
  try {
    args = parseArgs(argv, {
      booleans: ["dry-run", "summary", "help", "version", "force", "llm", "demo"],
      values: ["target", "format", "min-occurrences", "min-authors", "engine", "threshold", "api-key", "preset", "time-decay-half-life"],
      aliases: { h: "help", v: "version", t: "target", f: "force" },
    });
  } catch (e) {
    if (e instanceof ArgsError) {
      process.stderr.write(`Error: ${e.message}\n`);
      return 1;
    }
    throw e;
  }

  if (args.help) {
    process.stdout.write(HELP);
    return 0;
  }
  if (args.version) {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }

  // Apply preset before validation so preset-supplied numerics flow through.
  try {
    applyPreset(args, args.preset);
  } catch (e) {
    process.stderr.write(`Error: ${e.message}\n`);
    return 1;
  }
  if (args.preset) {
    process.stderr.write(`Preset: ${args.preset}\n`);
  }

  // ---- --demo short-circuit: bundled fixture + tmp target, no token needed ----
  // Runs the full pipeline against lib/fixtures/demo-typescript.json, writes
  // generated output into a temp dir, dumps each file to stdout for the user
  // to see, then cleans up. Lets evaluators see real output in ~5 seconds
  // without a GitHub token, a real input file, or a target repo.
  let input = args._[0];
  let target = args.target;
  let demoTarget = null;
  if (args.demo) {
    const here = dirname(fileURLToPath(import.meta.url));
    input = resolve(here, "..", "..", "lib", "fixtures", "demo-typescript.json");
    if (!existsSync(input)) {
      process.stderr.write(`Error: bundled demo fixture not found at ${input}\n`);
      return 1;
    }
    demoTarget = mkdtempSync(join(tmpdir(), "reviewlore-demo-"));
    target = demoTarget;
    process.stderr.write(
      `📦 Demo mode: using bundled fixture (${input.split("/").slice(-2).join("/")}).\n`,
    );
    process.stderr.write(`   Output target: ${demoTarget} (will be cleaned up).\n\n`);
  }

  if (!input) {
    process.stderr.write("Error: input JSON path is required (or pass --demo).\n\n");
    process.stderr.write(HELP);
    return 1;
  }
  if (!existsSync(input)) {
    process.stderr.write(`Error: input file not found: ${input}\n`);
    return 1;
  }

  if (!target && !args["dry-run"]) {
    process.stderr.write("Error: --target <repo-path> is required (or pass --dry-run / --demo).\n");
    return 1;
  }

  // Sanity-check --target before doing any work. We refuse to create skill
  // files in a path that doesn't already exist (catches typos like
  // `--target ~/code/myrep` missing the trailing `o`). A non-git target gets
  // a warning, not an error, because the tool is useful outside git too.
  if (target) {
    const resolvedTarget = resolve(target);
    if (!existsSync(resolvedTarget)) {
      process.stderr.write(`Error: --target path does not exist: ${resolvedTarget}\n`);
      return 1;
    }
    if (!statSync(resolvedTarget).isDirectory()) {
      process.stderr.write(`Error: --target must be a directory: ${resolvedTarget}\n`);
      return 1;
    }
    if (!demoTarget && !existsSync(join(resolvedTarget, ".git"))) {
      process.stderr.write(
        `Warning: --target is not a git repository (${resolvedTarget}). Continuing anyway.\n`,
      );
    }
  }

  const parseIntFlag = (raw, name, def) => {
    if (raw === undefined) return def;
    const n = parseInt(raw, 10);
    if (!Number.isFinite(n) || n < 1) {
      process.stderr.write(`Error: --${name} must be a positive integer (got "${raw}").\n`);
      return null;
    }
    return n;
  };
  const minOccurrences = parseIntFlag(args["min-occurrences"], "min-occurrences", 3);
  const minAuthors = parseIntFlag(args["min-authors"], "min-authors", 2);
  if (minOccurrences === null || minAuthors === null) return 1;

  const engineName = args.engine ?? "jaccard";
  if (engineName !== "jaccard" && engineName !== "semantic") {
    process.stderr.write(`Error: --engine must be "jaccard" or "semantic" (got "${args.engine}").\n`);
    return 1;
  }

  const formatArg = args.format ?? "claude";
  let formatNames;
  try {
    formatNames = resolveFormats(formatArg, target ? resolve(target) : process.cwd());
  } catch (e) {
    process.stderr.write(`Error: ${e.message}\n`);
    return 1;
  }
  const renderers = formatNames.map(getRenderer);
  if (formatArg === "auto") {
    process.stderr.write(`Auto-detected format(s): ${formatNames.join(", ")}\n`);
  }
  // Different engines use different similarity scales — pick a sensible
  // default if --threshold not given.
  const defaultThreshold = engineName === "semantic" ? 0.30 : 0.34;
  const threshold = args.threshold === undefined ? defaultThreshold : parseFloat(args.threshold);
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
    process.stderr.write(`Error: --threshold must be a number between 0 and 1 (got "${args.threshold}").\n`);
    return 1;
  }

  let data;
  try {
    data = JSON.parse(readFileSync(input, "utf-8"));
  } catch (e) {
    process.stderr.write(`Error: failed to parse JSON — ${e.message}\n`);
    return 1;
  }

  const halfLife = parseFloat(args["time-decay-half-life"] ?? "0");
  const candidates = extractCandidates(data, {
    signals: { timeDecayHalfLifeMonths: Number.isFinite(halfLife) ? halfLife : 0 },
  });
  process.stderr.write(`Extracted ${candidates.length} candidate sentences.\n`);

  const clusters = buildClusters(candidates, { threshold, engine: engineName });
  process.stderr.write(`Built ${clusters.length} raw clusters.\n`);

  const kept = filterClusters(clusters, { minOccurrences, minAuthors });
  process.stderr.write(
    `Kept ${kept.length} clusters (>= ${minOccurrences} occurrences, >= ${minAuthors} authors).\n\n`,
  );

  if (args.summary || args["dry-run"]) {
    process.stdout.write(renderSummary(kept, data.meta));
  }

  if (args["dry-run"]) {
    process.stderr.write("(dry-run — no files written)\n");
    return 0;
  }

  const force = Boolean(args.force);
  const resolvedTarget = resolve(target);

  // Diff against previous run's state, if any. We persist a tiny state
  // file (cluster labels + counts) inside .claude/ so re-runs can show
  // what changed.
  const previousState = loadPreviousState(resolvedTarget);
  const diffReport = reportDiffSinceLastRun(previousState, kept);
  if (diffReport) process.stderr.write(`\n${diffReport}`);

  // Optional LLM synthesis pass: turn each cluster into a polished rule.
  let synth = null;
  if (args.llm) {
    process.stderr.write(`Synthesising ${kept.length} rules via Claude...\n`);
    try {
      synth = await synthesiseAll(kept, { apiKey: args["api-key"] });
      const errs = synth.filter((s) => s?._error).length;
      const inc = synth.filter((s) => s?.name === "INCOHERENT").length;
      process.stderr.write(
        `LLM synthesis complete: ${synth.length - errs - inc} clean, ${inc} marked incoherent, ${errs} errored.\n`,
      );
    } catch (e) {
      process.stderr.write(`Error during LLM synthesis: ${e.message}\n`);
      return 1;
    }
  }

  const written = [];
  const skipped = [];
  for (const r of renderers) {
    const result = r.write(kept, {
      targetDir: resolvedTarget,
      force,
      synth,
      meta: data.meta,
    });
    for (const w of result.written) written.push({ ...w, format: r.name });
    for (const s of result.skipped) skipped.push({ ...s, format: r.name });
  }

  // Persist state for next run's diff.
  writeCurrentState(resolvedTarget, kept);

  // Track the rule files written, as `run` does, so `rules status` checks
  // them instead of listing them as written before 0.3.
  const ruleNames = written.filter((w) => w.format === "claude").map((w) => w.path.split(/[\\/]/).pop());
  if (ruleNames.length && !demoTarget) {
    recordFiles(resolvedTarget, ruleNames, {
      generator: synth ? "heuristic+llm" : "heuristic",
      byUrl: urlDates(data),
      ctx: { owner: data.meta?.owner, repo: data.meta?.repo, source: "file", fetchedAt: data.meta?.last_fetched_at ?? data.meta?.fetched_at ?? null },
    });
  }

  process.stderr.write(`\n✅ Wrote ${written.length} file(s) [format(s): ${formatNames.join(", ")}] into ${resolvedTarget}\n`);
  for (const w of written) {
    process.stderr.write(`   - [${w.format}] ${w.path}\n`);
  }

  // Demo mode: dump each generated file to stdout (so the user actually sees
  // the output without hunting for tmpdir paths), then clean up.
  if (demoTarget) {
    process.stdout.write("\n");
    process.stdout.write("═══════════════════════════════════════════════════════════════\n");
    process.stdout.write(`  Generated output (${written.length} file(s))\n`);
    process.stdout.write("═══════════════════════════════════════════════════════════════\n");
    for (const w of written) {
      process.stdout.write(`\n── ${w.path.replace(demoTarget, "<target>")} ───\n\n`);
      process.stdout.write(readFileSync(w.path, "utf-8"));
      process.stdout.write("\n");
    }
    process.stdout.write("═══════════════════════════════════════════════════════════════\n");
    process.stderr.write(`\n(demo mode: cleaned up ${demoTarget})\n`);
    rmSync(demoTarget, { recursive: true, force: true });
  }
  if (skipped.length > 0) {
    process.stderr.write(
      `\n⚠️  Skipped ${skipped.length} existing file(s) (pass --force to overwrite):\n`,
    );
    for (const s of skipped) {
      process.stderr.write(`   - ${s.path}\n`);
    }
  }
  return 0;
}

