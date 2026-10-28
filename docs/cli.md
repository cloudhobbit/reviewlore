# CLI reference

```bash
npm install -g reviewlore     # or: npx -y reviewlore <command>
```

Requires Node ≥ 20.11. One CLI, `reviewlore`, with these
commands:

| Command | What it does |
|---|---|
| [`run`](#run) (default) | Fetch review history and write rule files in one go. |
| [`candidates`](#candidates) | Print the filtered review feedback as JSON. Writes nothing. |
| [`fetch`](#fetch) | Fetch review history to JSON. |
| [`generate`](#generate) | Write rules from a fetched JSON file. |
| [`mcp`](#mcp) | Start the MCP server on stdio. |
| [`doctor`](#doctor) | Check Node, dependencies, git and the repo. Offline. |
| [`export`](#export) | Copy the reviewed rules to Copilot, Claude Code Review, AGENTS.md, Cursor or CLAUDE.md. |
| [`precedents`](#precedents) | What review history says about the files you changed, as JSON. Offline. |
| [`rules`](#rules) | Track generated rules and check whether they still hold. Offline. |
| [`init`](#init) | Interactive setup; saves a config file. |
| [`publish-corpus`](#publish-corpus) | Copy the cached history into the repo so teammates need no token. |

Every command takes `--help` and `--version`; neither needs a token or
network access. Output that is meant to be piped (JSON, summaries) goes to
stdout; progress and errors go to stderr.

## Authentication and GitHub hosts

reviewlore works with github.com, GHE.com (`<name>.ghe.com`) and GitHub
Enterprise Server. Inside a clone the host comes from `origin`, like the
owner and repo; otherwise `--host <name>`, then `GH_HOST`, then
github.com. `--api-url <url>` sets the REST base URL when it isn't the
host's standard one (`https://<host>/api/v3` on Enterprise Server). In
GitHub Actions, `GITHUB_API_URL` picks the instance the workflow runs on.

The token is looked up for that host only, so a github.com token never
reaches an enterprise server or the reverse:

| Host | Order |
|---|---|
| github.com, GHE.com | `--token`, `GH_TOKEN`, `GITHUB_TOKEN`, `gh auth token --hostname <host>` |
| GitHub Enterprise Server | `--token`, `GH_ENTERPRISE_TOKEN`, `GITHUB_ENTERPRISE_TOKEN`, `GITHUB_TOKEN` only inside Actions on that same server, `gh auth token --hostname <host>` |

If you use the GitHub CLI, `gh auth login --hostname <host>` is all it
takes. Public repos need the `public_repo` scope; private repos need
`repo`. The token is never printed, logged or written to output files.

A server with an internal certificate authority needs
`NODE_EXTRA_CA_CERTS=/path/to/ca.pem`; there is no switch to skip TLS
verification. Caches are kept per host (`~/.reviewlore/hosts/<host>/`),
and a committed corpus records its host, so `acme/app` on two hosts never
mix.

**GitLab** (gitlab.com and self-managed) works too. It's detected from
`origin` for gitlab.com and hosts named `gitlab.*`; pass
`--provider gitlab` (with `--host`) for any other self-managed GitLab.
Nested groups are fine (`group/sub/project`). The token comes from
`--token`, then `GITLAB_TOKEN`, then `GITLAB_ACCESS_TOKEN` — a personal
access token with the `read_api` scope, needed even for public projects
because GitLab doesn't serve merge-request comments anonymously — and a
GitHub token is never used for GitLab. Merge-request discussions map onto the same comment shape, so
everything downstream works unchanged; GitLab has no review bodies or
"changes requested" state, so nothing is weighted by review state, and
fetches don't resume yet (`--time-budget` is ignored). Bitbucket isn't
supported yet; its remotes are refused with a message.

`run` and `candidates` need no token at all when the repo contains a
committed corpus (see [`publish-corpus`](#publish-corpus)).

## run

```bash
reviewlore run [options]
```

From inside a git checkout, no options are needed: the GitHub repo comes
from `git remote get-url origin` and rules are written to the repo root.

Data source, in order:

1. A committed `.reviewlore-corpus.json` for the same repo — no
   token needed. (If you also have a local cache and a token, as the
   person who publishes the corpus does, the cache is topped up from
   GitHub so the next `publish-corpus` is current.) An explicit
   `--months` cuts the corpus to that window; otherwise all of it is used.
2. Otherwise GitHub. With a local cache
   (`~/.reviewlore/<owner>__<repo>.json`) only comments newer
   than the last fetch are downloaded; rules are built from the merged
   cache, limited to `--months`.

| Option | Default | |
|---|---|---|
| `--owner`, `--repo` | from `git remote` | GitHub repository |
| `--target <dir>` | git root of cwd | Where rule files are written |
| `--months <n>` | 6 | Lookback window |
| `--format <names>` | `claude` | Output format(s), see [Output formats](#output-formats) |
| `--min-occurrences <n>` | 3 | Min distinct (reviewer, PR) pairs per rule |
| `--min-authors <n>` | 2 | Min distinct reviewers per rule |
| `--single-reviewer` | | Single-maintainer repos: one reviewer on 3+ PRs is enough. Such rules are titled `Maintainer preference: …` and say their support is below the team bar |
| `--engine <name>` | `jaccard` | Clustering: `jaccard` or `semantic` (TF-IDF cosine) |
| `--threshold <0–1>` | per engine | Clustering similarity threshold |
| `--preset <name>` | — | Tuning profile, see [Presets](#presets) |
| `--time-decay-half-life <n>` | 0 (off) | Months; older comments rank lower |
| `--llm`, `--api-key <key>` | off | Rewrite rules with the Claude API (see [`generate`](#generate)) |
| `--dry-run` | | Print the summary, write nothing |
| `--force`, `-f` | | Overwrite existing rule files |
| `--refresh` | | Ignore a committed corpus and fetch from GitHub |
| `--no-cache` | | Don't read or update the local cache |
| `--token <token>` | | GitHub token |

Explicit flags beat the config file, which beats `--preset`, which beats
the defaults.

When no rule reaches the bar, `run` says why with numbers (too few PRs,
one dominant reviewer, or nothing recurring) and lists what to try, most
useful first — a longer window, `--single-reviewer`, or accepting that
there may be no conventions to learn yet. `candidates` puts the same
diagnosis in its JSON (`diagnosis: { reasons, suggestions }`) when none
of its clusters has 2+ PRs and 2+ reviewers.

Existing `pr-feedback-*.md` files are never overwritten without
`--force`. Each run stores a small state file
(`<target>/.claude/.reviewlore-state.json`) and prints what
changed since the previous run: new, strengthened, weakened and gone
rules.

## candidates

```bash
reviewlore candidates [--limit 150] [--min-occurrences 1] [options] > feedback.json
```

Same repo detection, data sources and auth as `run`, but instead of
writing rules it prints the filtered review feedback as JSON. This is what
the Claude Code plugin's `learn-from-reviews` skill reads. Thresholds are
loose on purpose, so single comments are included: a model reading the
quotes can merge differently worded requests that word-overlap
clustering keeps apart. Only `--min-occurrences` / `--min-authors` /
`--months` given on the command line apply; a preset or config file
doesn't tighten them.

```jsonc
{
  "repo": "owner/name",
  "since": "2025-12-03T…",
  "stats": { "comments": 6154, "candidates": 545, "clusters": 507, "shown": 150 },
  // Human review in the window, after bot / PR-author / AI-review filters.
  // warning: "thin" (< 50 PRs or < 3 reviewers), "single-reviewer"
  // (one reviewer wrote >= 80 %), or null.
  "history": { "prs": 350, "reviewers": 58, "comments": 1197, "top_reviewer_share": 0.45, "warning": null },
  // The target's instruction files (CLAUDE.md / AGENTS.md / REVIEW.md up
  // to 4 levels deep, .claude/rules/**, Copilot instructions); at most 50.
  "existing_instructions": [{ "path": "CLAUDE.md", "bytes": 5141, "generated": false }],
  "clusters": [
    {
      "id": "c1",
      "kind": "request",            // request | prescription | prohibition | question
      "label": ["add", "case", "test"],
      "occurrences": 7,             // distinct (reviewer, PR) pairs
      "reviewers": 3,
      "prs": 7,
      "globs": ["test/**/*.ts"],    // where the comments were made
      "last_seen": "2026-04-27T…",
      "quotes": [{ "text": "…", "author": "…", "pr": 9843, "url": "https://…", "path": "…" }]
    }
  ]
}
```

One cluster per line, strongest first (changes-requested reviews weigh
more). `--limit` caps the number of clusters (default 150, about 70 KB
on a busy repo).

`--save` writes the JSON to a new private temp file (mode 0600, in a
`reviewlore-*` directory under the system temp dir) and prints only its
path, so no shell redirection is needed — the plugin skill uses this
because it works the same in bash, PowerShell and cmd.
`candidates --discard <path>` deletes that file again; it refuses any
path `--save` didn't create.

`candidates --raw [--budget 60000] [--max-chars 1200]` skips the
English phrase matching: it prints whole human review comments, in any
language, after the same filters (no bots, AI reviews, PR authors,
resolved threads or praise, and no replies in threads a bot started).
One header line (`repo`, `url_base`, `history`, `stats`), then one
comment per line: `u` (the comment's URL is `url_base` + `u`), `by`,
`pr`, `k` (comment / inline / review), `state`, `path`, `at`, `text`.
Comments are ranked by review state and recency, taken round-robin
across top-level directories, until `--budget` (estimated tokens) is
spent; `stats.dropped_for_budget` says how many didn't fit. The plugin
uses it for reviews written in other languages, for teams whose
requests don't match the English phrasing, and for small repos.

`candidates --demo` prints a bundled sample instead
(`lib/fixtures/demo-candidates.json`: 60 clusters from vitest-dev/vitest's
public review history, reviewer names replaced with `user-N`). It needs
no repository, token or network, and works with `--save`. The plugin's
`/learn-from-reviews demo` uses it.

## fetch

```bash
reviewlore fetch [--owner <owner> --repo <repo>] [options]
reviewlore fetch <owner> <repo> [months]
```

Without `--owner`/`--repo` it uses the github.com `origin` of the
current directory's git repository, like `run`.

Fetches three kinds of review activity:

| Type | Endpoint |
|---|---|
| `issue_comment` | `GET /repos/{o}/{r}/issues/comments` — PR conversation only; comments on plain issues are skipped |
| `review_comment` | `GET /repos/{o}/{r}/pulls/comments` — inline comments on code lines |
| `review_submission` | GraphQL: PRs listed 100 per query, then their reviews 25 PRs per query, 4 queries at a time (REST `GET /repos/{o}/{r}/pulls/{n}/reviews` as a fallback) — every review (approve / request changes / comment); only those with a body yield feedback |

| Option | Default | |
|---|---|---|
| `--months <n>` | 6 | Lookback window |
| `--out <dir>` | `.` | Output directory |
| `--per-month` | | One file per `YYYY-MM` instead of one combined file |
| `--cache` | | Merge into `~/.reviewlore/<owner>__<repo>.json`; later runs fetch only what's new. Also saves progress, so an interrupted fetch resumes |
| `--no-output` | | With `--cache`: update the cache only, write no output file |
| `--time-budget <s>` | | With `--cache`: stop cleanly after `<s>` seconds, save progress, exit 75. Re-run the same command to continue |
| `--token <token>` | | GitHub token |

Exit codes: 0 done, 1 error, **75** stopped at `--time-budget` with
progress saved. The plugin skill fetches in 90-second steps this way, so
no single command runs long enough for Claude Code to move it to the
background.

Output: `pr-comments-<repo>-<timestamp>.json`:

```jsonc
{
  "meta": {
    "owner": "…", "repo": "…", "fetched_at": "…", "since": "…", "months_back": 6,
    "pr_authors": { "123": "alice" },   // used to drop PR authors' own comments
    "totals": { "issue_comments": 0, "review_comments": 0, "review_submissions": 0, "total": 0 }
  },
  "issue_comments":     [{ "comment_id": 1, "pr_number": 1, "author": "…", "body": "…", "created_at": "…", "html_url": "…" }],
  "review_comments":    [{ "…": "…", "path": "src/a.ts", "line": 12, "diff_hunk": "…", "in_reply_to_id": null }],
  "review_submissions": [{ "review_id": 1, "state": "CHANGES_REQUESTED", "…": "…" }]
}
```

The cache directory can be moved with `REVIEWLORE_CACHE_DIR`.

Requests: the two comment lists cost one request per 100 comments;
reviews cost one GraphQL query per 100 PRs updated in the window to list
them, plus one per 25 PRs for their reviews. On
busy repos the comment lists dominate, because they include every bot
comment and GitHub can't filter those out server-side. Measured on pnpm
in October 2026 (4,156 PRs and about 75,000 comments in six months,
three quarters of them from AI review bots): about 210 GraphQL queries
for reviews, against about 4,900 REST requests the old way, plus about
750 for comments. The comment lists are read in parallel time slices
(about a week each, 6 at a time), so their pages no longer queue up one
after another; `REVIEWLORE_FETCH_CONCURRENCY` changes the 6 (1 reads each
list in one go). Cached re-runs only cover what changed since the last
fetch.

Rate limits are handled for you: GitHub's `retry-after` is honoured, an
exhausted hourly limit that resets within a minute is waited out,
secondary limits back off from 60 s, and 502/504 responses are retried.
Otherwise the fetch stops, saves its progress (with `--cache`) and says
when the limit resets. Progress is one line with an estimated time left.

`REVIEWLORE_FETCH=rest` fetches reviews over REST (one request per PR, 4
in parallel), e.g. for a token without GraphQL access — reviewlore also
falls back to this on its own when GraphQL returns 403 or 404.

## generate

```bash
reviewlore generate <input.json> --target <dir> [options]
reviewlore generate --demo
```

Writes rules from a JSON file in the `fetch` format — from this tool or
any other source. Takes the same clustering, threshold, format, preset
and `--force` options as `run`, plus:

| Option | |
|---|---|
| `--demo` | Run on a bundled fixture and print the rules. No token, no files. |
| `--dry-run` | Print a summary of the rules that would be written, write nothing |
| `--summary` | Also print that summary when writing |
| `--threshold <0–1>` | Similarity threshold for clustering |
| `--llm` | Rewrite each rule with the Claude API |
| `--api-key <key>` | Anthropic API key (default: `ANTHROPIC_API_KEY`) |

**`--llm`** sends each kept cluster to `claude-sonnet-5-5` (override with
`REVIEWLORE_MODEL`) and asks for a named, generalised rule with a reason,
keeping the original quotes as evidence. It needs an Anthropic API key
and runs only on clusters the heuristic already found. A cluster the API
fails on keeps its heuristic text; the failure is reported on stderr and
in an HTML comment in the rule file, and doesn't fail the run. The Claude Code
plugin is usually the better option: it needs no key and can merge
paraphrased feedback the heuristic split up.

### Output formats

`--format` takes one name, a comma-separated list, `auto` (detect from
the files already in the target) or `all`.

| Format | Writes |
|---|---|
| `claude` (default) | `.claude/rules/pr-feedback-*.md`, scoped with `paths:` globs |
| `agents` | Managed section in `AGENTS.md` |
| `cursor` | `.cursor/rules/pr-feedback-*.mdc` |
| `copilot` | `.github/copilot-instructions.md` |
| `contributing` | Managed section in `CONTRIBUTING.md` |
| `json` | `reviewlore-rules.json` |
| `html` | `reviewlore-report.html`, a self-contained report |
| `aider` | Managed section in `CONVENTIONS.md` |
| `windsurf` | Managed block in `.windsurfrules` |

Managed sections sit between `reviewlore` start/end marker
comments (`<!-- reviewlore:start -->` in markdown, `# >>>
reviewlore start` in `.windsurfrules`); text outside the markers
is never touched.

A generated Claude rule:

```markdown
---
paths:
  - "test/**/*.ts"
---

<!-- Generated by reviewlore from PR review history. Review, edit or delete freely. -->

# Address: add / case / test

Reviewer feedback recurring 7× across 3 reviewers and 7 PRs:

> Let's add it as test case.

**Why:** …

**How to apply:** When editing files matching: `test/**/*.ts`. …

## Examples from PR review history

- > Can you also add another already working case as test cases?
  — @reviewer on PR #9843: https://github.com/…
```

`paths:` is the only frontmatter field Claude Code reads; the rule loads
when Claude works on matching files. Rules from comments that weren't on
a file have no frontmatter and load in every session.

### Presets

| Preset | For |
|---|---|
| `team-of-3` | Small team: min 2 occurrences, 6-month half-life |
| `team-of-50` | Large team: min 5 occurrences / 3 reviewers, semantic engine |
| `oss-maintainer` | Many drive-by reviewers: min 4 / 3, 12 months |
| `new-joiner` | What does this team care about? Min 2 / 2, 12 months, no decay |
| `monthly-refresh` | Scheduled runs: 1-month window, strong recency bias |
| `exploratory` | Show me everything: loosest thresholds, semantic engine |

## mcp

```bash
reviewlore mcp
```

A stdio MCP server that answers "what have reviewers said about this?"
while Claude works. The Claude Code plugin registers it automatically.
For other clients, or Claude Code without the plugin:

```bash
claude mcp add reviewlore -- npx -y reviewlore mcp
```

Inside a repository no arguments are needed beyond the path or query:
the repository is the git root of the project directory (from the plugin,
`CLAUDE_PROJECT_DIR`, the client's root or the working directory), and
the data is the newer of your cache (`~/.reviewlore`) and the committed
corpus. Answers start with the repo's own rules from `.claude/rules/`,
then human review comments — after the same filters as rule generation
(no bots, AI reviews, PR authors, resolved threads or praise), and
without replies in threads a bot started, which answer the bot rather
than review the code. Quotes are
capped at 400 characters and responses at about 16,000 characters.

| Tool | Returns |
|---|---|
| `review_feedback_for_path({path, months?, limit?})` | Rules scoped to the path, then review comments ranked by closeness (same file, directory, package), by what they ask (requests first) and recency. A thread shows once with its reply count; the same reviewer's repeated point shows once. |
| `search_review_feedback({query, path?, limit?})` | Matching rules, then review comments ranked by BM25 on their best sentence (words of 5+ letters also match their variants: "validation" finds "validate"), with how many PRs and reviewers the results cover. |
| `list_repos()` | Repositories with review history available; the current one is marked `default`. |
| `search_rules`, `recent_feedback` | The older tools, kept for now; use the two above. |

All tools also take `owner` and `repo` to ask about another repository.
The server tells Claude Code (in its instructions) to look up a path
before editing it, and `review_feedback_for_path` is loaded up front
rather than behind tool search.

## doctor

```bash
reviewlore doctor [--json] [--target <dir>]
```

Offline readiness check, run by the plugin skill before anything else.
It checks the Node version against `engines`, that git is on PATH, that
the directory is a clone of a github.com repository, whether a committed
corpus for that repo exists, and whether the npm dependencies
(`@octokit/rest`, `@modelcontextprotocol/sdk`) are installed. Each
failing check comes with a fix. It never looks for a token: auth
problems are reported by the command that needs one.

Exits 1 if a required check fails. `@octokit/rest` is required only when
there is no usable committed corpus; the MCP SDK is never required.
`--json` prints `{ ok, checks: [{ id, ok, required, message, fix? }] }`.

## rules

```bash
reviewlore rules status [--json] [--months 6]
reviewlore rules record <file…> | --all [--generator learn-from-reviews|heuristic|heuristic+llm] [--query "words"]
reviewlore rules dismiss <file…> [--reason r]
reviewlore rules dismiss --title "…" --urls a,b
reviewlore rules retire <file…>
```

Keeps `.claude/reviewlore-rules.json` — the committed record of which rule
files reviewlore wrote, from which review comments, and what each file
looked like then — in step with `.claude/rules/`. The plugin skill runs
these; `run` records the rules it writes. Offline. Only the manifest is
changed: rule files are written and deleted by the skill (with your
approval) or by `run`.

`status` reports, per generated rule:

| Suggestion | When |
|---|---|
| keep | still supported, or quotes aged out with nothing else wrong |
| update: refresh quotes | its quotes are older than the window but reviewers still ask for it, or some of its `paths` no longer match files |
| check contradictions | 2+ reviewers recently said the opposite (only for rules recorded with `--query`) |
| review: retire? | none of its `paths` match a tracked file any more |
| deleted: dismiss | its file was deleted; `rules dismiss` stops it being proposed again |

It also flags `edited` (the file changed since it was recorded; never
overwritten, even by `run --force`) and lists generated rules not tracked
yet (`rules record --all` adopts them). Recent support is counted by word
matching, so it is approximate; nothing is retired on age alone. The
report is Markdown (`--json` for tools) and the exit code is always 0.

## precedents

```bash
reviewlore precedents [--base <ref>] [--paths a,b] [--limit 8] [--months 12]
```

What the repo's review history says about the current changes, for the
plugin's `review-my-changes` skill (or your own tooling). Offline and
read-only: it never fetches.

- **Changed files:** everything since the merge base with `--base`
  (default: `origin`'s default branch, then `origin/main`,
  `origin/master`, `main`, `master`, from local refs), including staged,
  unstaged and untracked files. `--paths` lists files instead.
- **`rules`:** files in `.claude/rules/` whose `paths` match a changed
  file, then rules with no `paths` (they apply to every PR).
- **`recurring`:** feedback 2+ reviewers gave on 2+ PRs, about the changed
  files' areas or PR-wide, with quotes and links (at most `--limit`).
- **`file_history`:** per changed file, the three most relevant earlier
  review comments (same file, directory or package), ranked like the MCP
  server's `review_feedback_for_path`.

The JSON has a `status`: `ok`; `no-data` (no review history yet — rule
files are still checked); or `no-base`, `not-a-repo`, `no-repo`,
`git-error` with a `hint`. Those all exit 0 so a calling tool can explain
them; only bad flags exit 1.

## export

```bash
reviewlore export --to <targets> [--target <dir>] [--dry-run]
reviewlore export --to auto        # the tools this repo already uses
```

Reads the rules in `.claude/rules/pr-feedback-*.md` — the files you
reviewed, written by the plugin or by `run` — and renders them for other
AI reviewers, so one ruleset reaches all of them. No network, no model;
the output is deterministic.

| Target | Writes | Scoping |
|---|---|---|
| `copilot` | `.github/instructions/pr-feedback-<id>.instructions.md` (Copilot code review and coding agent) | `applyTo` = the rule's `paths` (`"**"` when unscoped) |
| `review` | `review-pr-feedback.md`, included from `REVIEW.md` with one `@review-pr-feedback.md` line (Claude Code Review) | an "Applies to:" line per rule |
| `agents` | a marked section in `AGENTS.md` | an "Applies to:" line per rule |
| `cursor` | `.cursor/rules/pr-feedback-<id>.mdc` | `globs` = the rule's `paths`; `alwaysApply` when unscoped |
| `claude-md` | a marked section in `CLAUDE.md` — opt-in, since `CLAUDE.md` loads in every session | none |

`auto` picks whichever of `copilot`, `review`, `agents` and `cursor` the
repo already has files for. Every exported file says which rule it came
from and keeps the source links, so a reader of any format can check it.

Re-run after editing or deleting rules: exports follow, and a deleted
rule's exports are removed. Only files carrying the "Exported by
reviewlore" line and the `<!-- reviewlore:start -->` sections are ever
changed; a hand-written file with a clashing name is left alone with a
warning. For `review`, it won't add a ninth include to `REVIEW.md`
(Claude Code Review reads at most eight) and warns when the included
files near 150,000 bytes. Claude Code Review honours `REVIEW.md`
includes only when it reads `REVIEW.md` from a protected branch.

## init

```bash
reviewlore init
```

Asks for the repo, target, format, preset, LLM use and window, and saves
them to `.reviewlore.json` in the target; later `run`s read it.

## publish-corpus

```bash
reviewlore run --dry-run          # with your token: fetches into ~/.reviewlore
reviewlore publish-corpus         # → .reviewlore-corpus.json (--force to refresh)
git add .reviewlore-corpus.json && git commit -m "Refresh PR review corpus"
```

Teammates' `run` and `candidates` — and the Claude Code plugin — then use
the committed file: no token, no network. `publish-corpus` refuses to
overwrite an existing corpus unless you pass `--force`, and leaves the
file untouched when no comments changed. Comment text and file paths
are scanned for credentials (GitHub, GitLab, npm, AWS, Google, Stripe,
Atlassian, Slack and Anthropic tokens, JWTs, private keys) before
publishing, and matches are redacted.

The corpus holds only what can affect the output: bot, short, praise,
PR-author and plain-issue comments are left out (except replies in a
review thread, which resolved-thread detection reads), as are the quoted
diff, PR titles and update times. `run`, `candidates` and the MCP tools
give byte-identical results from it, checked on five public repos. It
is about a tenth of the cache's size on busy repos (pnpm: 16.8 MB →
1.0 MB), with one record per line in a fixed order, so a refresh diff
shows just the comments that changed. `meta.source_totals` keeps the
counts as fetched. Older corpora still load; publishing again rewrites
them in the new format.

[`examples/github-action/`](../examples/github-action/) has a workflow
that refreshes the corpus on a schedule and opens a PR with the
`rules status` report, so only the bot needs a token.

## Environment variables

| Variable | |
|---|---|
| `GH_TOKEN`, `GITHUB_TOKEN` | Token for github.com and GHE.com |
| `GH_ENTERPRISE_TOKEN`, `GITHUB_ENTERPRISE_TOKEN` | Token for GitHub Enterprise Server |
| `GH_HOST` | GitHub host when there's no git remote to go by |
| `NODE_EXTRA_CA_CERTS` | Extra CA certificates (an Enterprise Server with an internal CA) |
| `GITLAB_TOKEN`, `GITLAB_ACCESS_TOKEN` | Token for GitLab (`read_api` scope) |
| `ANTHROPIC_API_KEY` | Anthropic API key for `--llm` |
| `REVIEWLORE_MODEL` | Model for `--llm` (default `claude-sonnet-5-5`) |
| `REVIEWLORE_CACHE_DIR` | Cache location (default `~/.reviewlore`) |
| `NO_COLOR` | Plain progress output |

## Exit codes

`0` on success — including "no rules met the thresholds" — and `1` on any
error (bad flags, missing input, GitHub failures). Per-rule `--llm`
failures are reported but don't change the exit code.
