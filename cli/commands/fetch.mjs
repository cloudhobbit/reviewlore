import { parseArgs, ArgsError } from "../../lib/args.mjs";
import { sinceFromMonths } from "../../lib/filters.mjs";
import { PartialFetch, fetchConcurrency } from "../../lib/fetchers.mjs";
import { openFetcher } from "../../lib/providers/index.mjs";
import { writeSingleFile, writePerMonth } from "../../lib/output.mjs";
import { mergeIntoCache, incrementalSince, cachePath } from "../../lib/cache.mjs";
import { resolveRepo, repoLabel } from "../../lib/git-info.mjs";
import { explainGitHubError } from "../../lib/github-errors.mjs";

// Exit code for "stopped at --time-budget, progress saved" (EX_TEMPFAIL).
export const EXIT_PARTIAL = 75;

const VERSION = "0.3.0";

const HELP = `reviewlore fetch v${VERSION}

Fetch all PR review activity (issue comments, inline review comments, and
review submissions) from a GitHub repository over the last N months.

Usage:
  reviewlore fetch [--owner <owner> --repo <repo>] [options]
  reviewlore fetch <owner> <repo> [months]      (positional shorthand)

Options:
  --owner <name>       GitHub owner / org (default: from \`git remote\` origin)
  --repo <name>        GitHub repository name (default: from origin)
  --months <n>         How many months back to fetch (default: 6)
  --out <dir>          Output directory (default: ".")
  --per-month          Write one JSON file per month instead of one combined file
  --cache              Merge results into ~/.reviewlore/<owner>__<repo>.json,
                       use the last fetch time as the incremental cutoff, and
                       save progress so an interrupted fetch resumes
  --no-output          With --cache: update the cache only, write no file
  --time-budget <s>    Stop cleanly after <s> seconds, save progress (needs
                       --cache) and exit 75; re-run the same command to continue
  --token <token>      GitHub token (falls back to GH_TOKEN / GITHUB_TOKEN, then
                       \`gh auth token --hostname <host>\`; GH_ENTERPRISE_TOKEN on GHES)
  --host <name>        GitHub host (default: the git remote's host, then GH_HOST, github.com)
  --api-url <url>      REST API base URL, if not the host's standard one
  --provider <name>    github (default) or gitlab (auto for gitlab.com and gitlab.* hosts);
                       GitLab reads GITLAB_TOKEN (read_api scope)
  --version            Print version and exit
  --help               Show this help and exit

Environment:
  GITHUB_TOKEN         Used when --token is not supplied
  REVIEWLORE_FETCH=rest  Fetch reviews over REST instead of GraphQL

Exit codes: 0 done · 1 error · 75 stopped at --time-budget (progress saved)

Examples:
  GITHUB_TOKEN=ghp_xxx reviewlore fetch --owner facebook --repo react
  reviewlore fetch facebook react 12
  reviewlore fetch --owner my-org --repo my-repo --months 3 --per-month --out ./out
`;

export async function main(argv) {
  let args;
  try {
    args = parseArgs(argv, {
      booleans: ["per-month", "cache", "help", "version", "no-output"],
      values: ["owner", "repo", "months", "out", "token", "time-budget", "host", "api-url", "provider"],
      aliases: { h: "help", v: "version", o: "owner", r: "repo", m: "months" },
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

  const where = resolveRepo({
    owner: args.owner ?? args._[0], repo: args.repo ?? args._[1], host: args.host, apiUrl: args["api-url"], provider: args.provider, dir: process.cwd(),
  });
  if (where.error) {
    process.stderr.write(`Error: ${where.error}\n`);
    return 1;
  }
  const { owner, repo, host = "github.com", provider = "github" } = where;
  if (where.detected) process.stderr.write(`Detected ${repoLabel(owner, repo, host)} from git origin.\n`);
  const monthsBack = parseInt(args.months ?? args._[2] ?? "6", 10);
  const outDir = args.out ?? ".";
  const perMonth = Boolean(args["per-month"]);

  if (!owner || !repo) {
    process.stderr.write("Error: --owner and --repo are required (or run from inside a clone of the repository).\n" +
      "Run `reviewlore fetch --help` for usage.\n");
    return 1;
  }
  if (!Number.isFinite(monthsBack) || monthsBack <= 0) {
    process.stderr.write(`Error: --months must be a positive integer (got "${args.months}").\n`);
    return 1;
  }
  let budgetMs;
  if (args["time-budget"] !== undefined) {
    const seconds = Number(args["time-budget"]);
    if (!Number.isFinite(seconds) || seconds < 0) {
      process.stderr.write(`Error: --time-budget must be a number of seconds (got "${args["time-budget"]}").\n`);
      return 1;
    }
    budgetMs = seconds * 1000;
  }
  if ((budgetMs !== undefined || args["no-output"]) && !args.cache) {
    process.stderr.write("Error: --time-budget and --no-output need --cache (progress and results are kept there).\n");
    return 1;
  }

  const fetcher = await openFetcher(where, { token: args.token });
  if (fetcher.error) {
    process.stderr.write(`Error: ${fetcher.error}\n`);
    return 1;
  }
  if (provider === "gitlab" && budgetMs !== undefined) {
    process.stderr.write("Note: GitLab fetches don't resume yet, so --time-budget is ignored: this fetch runs to the end.\n");
  }

  let since = sinceFromMonths(monthsBack);
  if (args.cache) {
    const incSince = incrementalSince(owner, repo, since, host);
    if (incSince && incSince > since) {
      process.stderr.write(
        `Cache hit: fetching incrementally since ${incSince.toISOString()} (last cache write).\n`,
      );
      since = incSince;
    } else {
      process.stderr.write(
        `Cache: nothing cached for ${repoLabel(owner, repo, host)} back to ${since.toISOString().slice(0, 10)} — fetching the full window.\n`,
      );
    }
  }
  process.stderr.write(`\nFetching all PR comments for ${repoLabel(owner, repo, host)}\n`);
  process.stderr.write(`Range: ${since.toISOString()} → now\n\n`);

  try {
    const output = await fetcher.fetch({
      since, monthsBack, out: process.stderr, mode: process.env.REVIEWLORE_FETCH, concurrency: fetchConcurrency(),
      checkpoint: Boolean(args.cache), budgetMs,
    });

    let written = [];
    if (args.cache) {
      // Merge into the persistent cache. Still write the run-level file
      // too so the user has a discrete artifact to point downstream tools at.
      const cachePathOut = mergeIntoCache(owner, repo, output, host);
      process.stderr.write(`📦 Cache updated: ${cachePathOut}\n`);
    }
    if (args["no-output"]) {
      // Cache only.
    } else if (perMonth) {
      const dir = outDir === "." ? `pr-comments-${repo}` : outDir;
      written = writePerMonth(output, { outDir: dir, repo });
    } else {
      written = [writeSingleFile(output, { outDir, repo })];
    }

    const t = output.meta.totals;
    process.stderr.write(`\n✅ Done!\n`);
    process.stderr.write(`   Issue comments:      ${t.issue_comments}\n`);
    process.stderr.write(`   Review comments:     ${t.review_comments}\n`);
    process.stderr.write(`   Review submissions:  ${t.review_submissions}\n`);
    process.stderr.write(`   ─────────────────────────────\n`);
    process.stderr.write(`   Total:               ${t.total}\n\n`);
    for (const f of written) process.stderr.write(`📄 ${f}\n`);
    process.stderr.write("\n");
    return 0;
  } catch (err) {
    if (err instanceof PartialFetch) {
      process.stderr.write(`${err.message}\n`);
      return EXIT_PARTIAL;
    }
    process.stderr.write(`\n❌ ${explainGitHubError(err, { owner, repo, host, provider })}\n`);
    return 1;
  }
}

