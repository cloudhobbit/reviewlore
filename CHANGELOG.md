# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

> For the internal audit trail mapping each change to the review pass
> that identified it, see [`docs/audit-history.md`](./docs/audit-history.md).

## [Unreleased]

## [0.3.0] — 2026-10-28

### Added — plugin preflight

- `reviewlore doctor [--json]`: offline check of Node version, git, the
  repo's origin, a committed corpus and the npm dependencies, each with a
  fix. Reads no credentials.
- `candidates --save` writes the feedback to a private temp file (0600)
  and prints its path; `candidates --discard <path>` deletes it and
  refuses any other path.
- The `learn-from-reviews` skill runs `doctor` first and stops with a
  plain message when Node or the plugin's dependencies are missing, and
  uses `--save` / `--discard` instead of `mktemp` / `rm`, so its commands
  work in bash, PowerShell and cmd.
- Missing-dependency errors (fetch and MCP server) say to reinstall the
  plugin with npm on PATH, or name the directory to run `npm install` in.

### Added — GitLab

- gitlab.com and self-managed GitLab: detected from `origin` (gitlab.com,
  hosts named `gitlab.*`) or `--provider gitlab`; nested groups work.
  Merge-request discussions are fetched with Node's `fetch` (no new
  dependency) and mapped onto the same comment shape — standalone notes,
  diff threads with path/line and reply links, system notes dropped — so
  candidates, rules, raw mode, the MCP server and the skills work
  unchanged. Token: `--token`, `GITLAB_TOKEN`, `GITLAB_ACCESS_TOKEN`
  (`read_api`); a GitHub token is never sent to GitLab.
- Not yet: Bitbucket, resumable GitLab fetches, `glab` as a token-free
  transport. Tested with fakes only, not against a live GitLab.

### Added — reviews in any language (raw mode)

- `candidates --raw [--budget] [--max-chars]`: whole human review
  comments as JSONL, with no English phrase matching — only the
  language-agnostic filters — ranked by review state and recency,
  round-robin across directories, within a token budget. Links are
  `url_base` + `u`, on the repository's own host.
- The `learn-from-reviews` skill switches to it when the user asks, when
  phrase matching finds under 20 sentences but there are 50+ human
  comments, or when the whole history is small (300 comments or fewer),
  and quotes reviewers in their original language.
- `npm run eval:real` reports and guards raw mode's recall ceiling: all
  60 labelled review requests survive its filters (the phrase matcher's
  held-out recall is 64%).
- Inline comments take the state weight of the review they were posted in
  (`pull_request_review_id`, stored from new fetches); the slim corpus
  keeps such parent reviews, so its output stays identical.

### Changed — CLI moved from bin/ to cli/

- The entry points live in `cli/` (`cli/reviewlore.mjs`, `cli/commands/`).
  A Claude Code plugin's top-level `bin/` is put on the Bash tool's PATH
  while the plugin is enabled, and claude.ai / Cowork won't install a
  plugin that has one. npm users see no change: the `reviewlore` command
  is the same. The pack check refuses a `bin/` directory.
- CI has a Windows job (Git Bash, Node 22): tests, evals and the smoke
  test; `.gitattributes` keeps LF line endings on Windows checkouts.
- On Windows, the repository root is reported as a native path (`C:\x`,
  not git's `C:/x`), and the test suite no longer assumes POSIX paths.

### Added — GitHub Enterprise

- GHE.com and GitHub Enterprise Server: the host comes from `origin` (or
  `--host`, `GH_HOST`, Actions' `GITHUB_API_URL`), with `--api-url` for a
  non-standard API path. The REST and GraphQL calls, the cache
  (`~/.reviewlore/hosts/<host>/`), partial fetches, the committed corpus
  (`meta.host`), the MCP server, `doctor` and the init wizard all carry
  the host; github.com paths are unchanged.
- Tokens are per host, following the gh CLI: `GH_TOKEN` / `GITHUB_TOKEN`
  for github.com and GHE.com, `GH_ENTERPRISE_TOKEN` /
  `GITHUB_ENTERPRISE_TOKEN` for Enterprise Server (`GITHUB_TOKEN` only in
  Actions on that same server), and `gh auth token --hostname <host>`.
  A github.com token is never sent to another host.
- Remotes: SSH aliases like `github.com-work` count as github.com; an
  ssh:// port is no longer mistaken for the web port; GitLab subgroups,
  Bitbucket and unresolvable aliases are refused with the reason.
- Errors name the host (`gh auth login --hostname …`, "wasn't found on
  ghe.acme.corp").

### Added — small and single-maintainer repos

- An empty result explains itself in both `run` (stderr) and
  `candidates` (`diagnosis: { reasons, suggestions }`): too few PRs, one
  dominant reviewer, or nothing recurring, with the numbers, and the next
  steps in order — a longer window, single-maintainer mode, or accepting
  zero.
- Single-maintainer mode: `run --single-reviewer` and
  `/reviewlore:learn-from-reviews single-maintainer` accept one reviewer
  on 3+ PRs. Those rules are titled `Maintainer preference: …` and carry
  a support line saying they're below the team bar. The default bar is
  unchanged.
- The skill drops groups whose newest quote is over 18 months old on long
  windows, unless the user keeps them.

### Added — keeping rules fresh

- `.claude/reviewlore-rules.json`: a committed record of each generated
  rule — generator, evidence with dates, `paths`, file hash — written
  only when it changes. The skill records the rules it writes; `run`
  records heuristic ones.
- `reviewlore rules status`: per rule, whether recent review still backs
  it (word-matched, approximate), whether its `paths` still match files,
  whether it was edited or deleted, and — for rules recorded with a
  query — whether 2+ reviewers recently said the opposite. Suggests keep,
  refresh quotes, check, retire or dismiss; never retires on age alone
  (pnpm's changeset rule: quotes from January, 26 PRs of support now).
- `rules record | dismiss | retire` keep the record in step; declined
  proposals are remembered and not re-proposed unless support doubles.
- The `learn-from-reviews` skill has a refresh mode that proposes KEEP /
  UPDATE / RETIRE / ADD as diffs for approval.
- `run --force` no longer overwrites a rule the record marks as written by
  the plugin, or one edited since it was generated.
- GitHub Actions: the recommended workflow is now
  `refresh-review-corpus.yml` — it refreshes the corpus and opens a PR
  whose description is the status report; no API key, no rule rewrites.
  The heuristic one is `regenerate-heuristic-rules.yml`.

### Added — check changes against review history

- `/reviewlore:review-my-changes` (plugin skill): before opening a PR,
  lists what this repo's reviewers are likely to ask for on the current
  changes — rules the diff breaks or leaves undone, and requests 2+
  reviewers made on 2+ PRs — each with its rule file or review link and
  the place in the diff. No general review, no edits; "nothing applies"
  is a valid answer.
- `reviewlore precedents`: the offline JSON behind it — changed files
  since the merge base (committed, unstaged and untracked), matching
  rules, recurring feedback for those areas, ranked file history.
- Rule `paths` may use character classes (`[abc]`), for hand-written rules.

### Changed — an MCP server worth keeping on

- New tools `review_feedback_for_path` and `search_review_feedback`;
  owner/repo are optional inside a repository (git origin, else the
  committed corpus). Answers start with the repo's `.claude/rules/` files,
  then human review comments after the extraction filters (no bots, AI
  reviews, PR authors, resolved threads or praise).
- Search is BM25 over review sentences with stem-prefix matching
  ("validation" finds "validate"), and ranks requests a little higher.
  On the gallery check (`eval/search-gallery.mjs`, rule titles as
  queries) a cited comment is in the top 5 for 10 of 14 rules (the old
  `search_rules`: 5 of 14).
- Path feedback ranks same file > directory > package, then requests
  first, then recency; collapses threads with a reply count and merges a
  reviewer's repeated point.
- The index is built once per data/rule-file version and shared by
  concurrent calls; queries take about 1 ms. Caches over 20 MB are
  indexed in a short-lived child process: on pnpm's 441 MB cache the
  server then sits at ~180 MB instead of ~1.1 GB. It picks the newer of
  cache and committed corpus, reading only the cache's first bytes.
- Human replies in threads a bot or AI reviewer started ("Declined.",
  "Fixed in abc123") are left out: on pnpm they were 196 of the 197
  inline comments on its most-reviewed file.
- Quotes capped at 400 characters, responses at ~16,000 characters.
- Server instructions tell Claude Code to look up a path before editing
  it; `review_feedback_for_path` loads up front. The client's workspace
  root is used when no project directory is passed.
- `search_rules` and `recent_feedback` remain, deprecated.

### Fixed — AI reviews from user accounts

- Also treated as AI-written: a review that opens with a priority tag
  (`[P2] …`, Codex-style) or has a sentence starting "Automated review".
  Found through the plugin's MCP server on express; across six repos
  (~39,500 human-account comments) the new signals match only that one
  AI review. Evals unchanged.

### Added — one ruleset for every reviewer

- `reviewlore export --to copilot,review,agents,cursor,claude-md|auto`
  renders the reviewed `.claude/rules/pr-feedback-*.md` files for GitHub
  Copilot (path-scoped `.github/instructions/*.instructions.md`), Claude
  Code Review (`review-pr-feedback.md` included from `REVIEW.md`),
  AGENTS.md, Cursor (`.mdc` with globs) and, opt-in, CLAUDE.md.
  Deterministic and idempotent; deleted rules' exports are removed;
  only files and sections it wrote are ever changed. Respects Claude Code
  Review's include count and size limits.
- The `learn-from-reviews` skill offers the export when the repository
  already uses one of those tools.

### Changed — slim committed corpus

- `publish-corpus` writes only what can change the output: no bot,
  short, praise, PR-author or plain-issue comments (thread replies stay,
  cut to the words resolved-thread detection reads), and no `diff_hunk`,
  `updated_at` or `pr_title`. Output from `run`, `candidates` and the MCP
  tools is byte-identical (verified on vitest, pnpm, express,
  commander.js and swr; golden test in `test/slim.test.mjs`). pnpm:
  16.8 MB → 968 KB; vitest: 7.0 MB → 910 KB.
- One record per line, sorted, fixed field order: refresh diffs show
  only changed comments. `meta.schema_version: 2`, `meta.source_totals`
  (counts as fetched, shown by `candidates`), `meta.slim.dropped`.
- Quoted code is no longer published, and file paths are now
  secret-scanned too.

### Changed — clearer errors

- GitHub failures say what to do: an invalid or expired token, a token
  not authorised for an organisation's SAML SSO, missing scope (which
  one), a repository that doesn't exist or isn't visible to the token,
  network errors, GitHub server errors. Built from the status and
  GitHub's message only — never headers.
- Unknown options are errors, with a suggestion for near misses
  (`--month` → "Did you mean --months?"), in `run`, `candidates`,
  `fetch` and `generate`. They used to be silently ignored.
- Missing `--owner`/`--repo` prints one hint line instead of the whole
  help.
- `run` explains an empty result from the review history (too few PRs,
  too few reviewers, one dominant reviewer, or nothing recurring) and
  suggests the next step.

### Added — specific, non-conflicting rules

- `candidates` reports `history` (PRs and reviewers with human review in
  the window, top reviewer's share, and a `thin` / `single-reviewer`
  warning) and `existing_instructions` (the repo's CLAUDE.md, AGENTS.md,
  REVIEW.md, `.claude/rules/**` and Copilot instruction files).
- The `learn-from-reviews` skill warns up front on thin history, drops
  generic best practice unless the quotes add a repo-specific detail,
  labels each rule NEW / DUPLICATE / VIOLATED / CONTRADICTS against the
  existing instructions (never writing duplicates or contradictions),
  shows the context cost of what it adds, and explains an empty result
  with next steps.

### Changed — faster fetching

- Reviews are fetched with GitHub's GraphQL API instead of one REST
  request per PR: the PRs are listed 100 per query, then their reviews
  fetched 25 PRs per query, 4 queries at a time. Measured on pnpm
  (October 2026, 4,156 PRs in six months): about 210 queries for reviews
  where REST needs about 4,900 requests. (A first version paged 50 PRs
  with their reviews per query; one at a time, that took 5 minutes on
  pnpm and set the pace of the whole fetch.) Records are identical to the REST path (unit
  parity test, and a live one-month comparison on pnpm: 9,565 reviews,
  no differences). Falls back to REST, 4 requests at a time, when GraphQL
  isn't available to the token; `REVIEWLORE_FETCH=rest` forces it.
- Rate limits are handled: `retry-after` is honoured, a soon-resetting
  primary limit is waited out (up to 60 s), secondary limits back off
  from 60 s, 502/504 are retried. Otherwise the error says when the limit
  resets.
- Progress is one line with an ETA (rewritten in place on a terminal,
  at most every 5 s elsewhere) and ends with the request count.
- Fetches resume: progress is checkpointed in the cache directory (at
  most every 5 s, and on any failure), and the next fetch of the same
  repo continues from it. After an interrupted fetch completes, the
  cache's incremental cutoff is when the first run started, so nothing
  updated in between is missed.
- Comment listings are read in parallel time slices (about a week each,
  6 at a time, shared by both lists), with the same requests and the
  same records as one long listing; resume works per slice. The inline
  review-comment list alone took about 5 minutes on pnpm when read page
  by page. `REVIEWLORE_FETCH_CONCURRENCY` sets the parallelism.
- Comment listings no longer end early when GitHub stops paginating a
  long listing (pnpm's issue comments ended mid-September with no error):
  a listing that ends is continued from the last update time seen, and
  ends only on GitHub's own "no next page", not on a short page.
- The REST review fallback resumes per PR instead of starting over, and
  stops its other workers as soon as one fails.
- Octokit's own "GET … - 403" lines no longer break into the progress
  line.
- `fetch --time-budget <s>` stops cleanly, saves progress and exits 75;
  `fetch --no-output` updates the cache only; `fetch` detects
  owner/repo from `git remote` like `run`. The plugin skill fetches in
  90-second steps this way.
- GitHub Action template: restores the previous run's cache with
  `actions/cache` (seeding from the committed corpus only when there is
  none) and fetches with `--no-output`.

### Added — demo inside Claude Code

- `/learn-from-reviews demo` and `candidates --demo`: a bundled sample of
  vitest's public review history (60 clusters, reviewer names
  pseudonymised) to try the skill with no repository, token or network.
  The skill proposes rules from it and writes nothing.
- `generate --demo` no longer warns that its temp directory isn't a git
  repository.

### Added — rule-file checker

- `npm run eval:skill` (in CI): checks every gallery rule file against
  the `candidates` output it cites — file name, provenance, `paths`-only
  frontmatter, citations verbatim with matching author and PR, ≥ 2 PRs
  and ≥ 2 reviewers, and scope. 14/14 gallery rules pass.
  `eval/skill/check-rules.mjs <rules-dir> <candidates.json>` checks any
  skill output.

### Fixed

- Piped output was cut off at 64 KB on macOS (`candidates | jq`, large
  `fetch` output): the CLI exited before stdout flushed. It now exits
  once both streams have drained.

### Renamed: pr-comments-toolkit → reviewlore

The project, npm package, CLI command and Claude Code plugin are now
**reviewlore** (no release under the old name was ever published, so
there are no compatibility aliases):

- Command: `reviewlore run | candidates | fetch | generate | mcp | init | publish-corpus`.
  The old `fetch-pr-comments`, `pr-comments-to-skills` and
  `pr-comments-mcp` commands are gone — use the subcommands.
- Plugin: `/plugin install reviewlore@reviewlore`; skill
  `/reviewlore:learn-from-reviews`; MCP server `reviewlore`.
- Files: `.reviewlore-corpus.json`, `.reviewlore.json` (config),
  `.claude/.reviewlore-state.json`, `reviewlore-report.html`,
  `reviewlore-rules.json`; cache in `~/.reviewlore/`.
- Environment: `REVIEWLORE_CACHE_DIR`, `REVIEWLORE_MODEL`,
  `REVIEWLORE_PROJECT_DIR`.
- Generated rule files keep the `pr-feedback-` prefix.

### Fixed — found while planning (docs/plans, Phase 0)

- **GitHub Enterprise / GitLab checkouts no longer query github.com.**
  The remote parser kept owner/repo from any host and dropped the host, so
  the CLI looked up a same-named github.com repository with the user's
  github.com token. Non-github.com origins now stop with a clear message
  (real support: docs/plans/02).
- **`scripts/check-secrets.sh` no longer prints matched secrets** into
  CI logs — it reports file, line numbers and the pattern only.
- **Secret scanning covers more formats and quoted code**: GitHub
  `ghu_`/`ghr_`, GitLab, npm, Google, Stripe, Atlassian, JWTs and any PEM
  private key (PKCS#8, encrypted), in comment text and `diff_hunk`.
- **AI reviewers posting from user accounts are filtered** (signed
  reviews, or report labels with severities). Held-out precision
  69.6% → 72.7%, recall unchanged; the CI floor rises to 70%.
- **The cache kept the wrong window start** after an incremental fetch,
  and asking for more months than cached never fetched the older
  history. The cache now keeps its earliest start and backfills.
- **Progress output without a terminal** printed one line per PR (~970
  on a busy repo, all of it in Claude's context when the skill ran it);
  it now prints every 10%.
- **A corrupt committed corpus** (e.g. merge-conflict markers) crashed
  `run`/`candidates`; it is now ignored with a warning.
- **MCP `search_rules` topic matching** used substrings, so "add a
  changeset" matched almost everything via "a"; it now matches whole
  tokens.
- **The plugin's MCP server looks for the committed corpus in the user's
  project** (`CLAUDE_PROJECT_DIR`, passed by plugin.json, at its git
  root) instead of whatever directory it was started in.
- **GitHub Action template**: seeds its cache from the committed corpus
  so weekly runs fetch only what's new (a full fetch could exceed the
  Actions token's hourly limit); unchanged corpora and rule state are no
  longer rewritten, so quiet weeks open no PR; heuristic runs never
  overwrite rules written by the Claude Code plugin, even with `--force`.
- **README privacy section** said everything stays on your machine; it
  now says what reaches a model provider when the plugin or `--llm` is
  used.

### Fixed — review round

- **Re-runs built rules from almost nothing.** With an existing cache,
  `run` and `candidates` fetched only comments newer than the last fetch
  and clustered just those. They now merge into the cache and use the
  whole `--months` window.
- **A committed corpus overrode `--owner`, `--repo` and `--months`.** A
  corpus for another repo is now ignored with a warning, and an explicit
  `--months` cuts the corpus to that window.
- **Presets and config tightened `candidates`.** It now honours only
  thresholds given on its own command line, so the plugin skill always
  sees single comments.
- **Bullet-list reviews produced nothing**, because line breaks were
  collapsed before sentence splitting. List items are now separate
  sentences; single backticks spanning several lines count as code.
- **Generics were stripped as HTML** (`Promise<void>` → `Promise`), and a
  link whose text is code left junk. Only real HTML tags are removed now.
- **"No need to add X" clustered with "add X".** Removal advice and
  "is this necessary?" questions are kept apart from requests to add.
- **Offline commands needed every dependency.** `--help`, `generate` and
  runs from a committed corpus now work without `@octokit/rest`; GitHub
  access without it gives an actionable error.
- **MCP server input wasn't validated.** Arguments are checked against
  each tool's schema, and `owner` / `repo` must be plain GitHub names (a
  `../` owner could read other files in the cache directory).
  `list_repos` includes a committed corpus; paths may end in `/`.
- CLI: flags before a command (`--dry-run generate …`) now dispatch to
  that command; `--engine`, `--threshold`, `--min-occurrences` and
  `--min-authors` are validated in `run` and `candidates`, and
  `--threshold` is no longer ignored there; `--llm` failures in `run` are
  reported on stderr.
- `nit -` style prefixes need a spaced dash ("Optional-chaining" keeps
  its first word).
- A test made a live GitHub API call with a fake token on every run; the
  CLI tests are now fully offline.
- GitHub Action template: no second fetch per run, no 1-month window
  from the default preset, and the raw fetch output stays out of the PR.

### Documentation

- **README rewritten for users**: what you get (a real generated rule),
  plugin and CLI quick starts, team setup, honest expectations, privacy.
  Reference material moved to `docs/cli.md` (every command and flag) and
  `docs/how-it-works.md` (pipeline, evaluation, limitations).
  `OVERVIEW.md`, `PUBLISHING.md` and the per-command docs were folded in
  and removed; release steps now live in `CONTRIBUTING.md`.
- **Example gallery regenerated** (`examples/real-repos/`) with both the
  plugin skill's rules and the heuristic CLI's rules for vitest, pnpm,
  express, commander.js and swr.
- Command help texts use the `reviewlore <command>` form.

### Fixed — quotes in generated rules

- Markdown links kept only a stray `[text](` once the URL was stripped;
  they now render as their text.
- `@mentions` were stripped inside code spans, turning
  `` `@pnpm/plugin-commands-sbom` `` into `` ` /plugin-commands-sbom` ``.
  Code spans are now left intact; images and HTML tags are removed.
- A Claude rule's "How to apply" line named file extensions while its
  `paths:` named directories; both now use the same globs.

### Added — Claude Code plugin

- **The repo is now a Claude Code plugin** (`.claude-plugin/`):
  `/plugin marketplace add cloudhobbit/reviewlore`, then
  `/plugin install reviewlore@reviewlore`.
- **`learn-from-reviews` skill**: Claude fetches the review history via
  `reviewlore candidates`, merges comments that ask for the same
  thing in different words, applies the evidence bar (≥ 2 PRs, ≥ 2
  reviewers), shows the proposed rules for approval, then writes
  path-scoped `.claude/rules/pr-feedback-*.md`. No Anthropic API key
  needed. On vitest's history it proposes 6 evidence-backed rules where
  the heuristic pipeline finds 3 (one of them "resolve conflicts").
- **`reviewlore candidates`**: prints filtered, loosely
  clustered review feedback as compact JSON (quotes, PRs, reviewers,
  path globs) for a model or `jq` to work with.
- The plugin registers the MCP server, run from the plugin's own copy.

### Changed

- **One CLI.** `reviewlore fetch | generate | mcp` run the
  individual stages; `fetch-pr-comments`, `pr-comments-to-skills` and
  `pr-comments-mcp` remain as aliases.
- **Claude rules are path-scoped.** Generated `.claude/rules/*.md` files
  carry a `paths:` glob list (top-level directory or package + extension,
  e.g. `packages/vitest/**/*.ts`) when the source comments were on files,
  so they load only when Claude works on matching files. The ignored
  `name` / `description` / `type` frontmatter is gone; the title is now an
  H1 heading. Rules from comments with no file stay unscoped.

### Fixed

- **`pr-comments-mcp` crashed on startup in every release.** It passed
  JSON-schema objects to `McpServer.tool()`, which only accepts Zod
  shapes; the smoke test only exercised `--help`. The server now uses the
  SDK's low-level `Server` with JSON Schema tools (no new dependency) and
  is covered by a stdio test. `recent_feedback` now skips bots and the PR
  author's own replies, and both tools fall back to a corpus committed in
  the repo the server is started from.
- An LLM error message containing `-->` could break out of the HTML
  comment that records it in the rule file.

### Upgrade note

Rule extraction changed substantially (see below), and cluster labels now
fold plurals ("types" → "type"), so regenerated rules get new file names.
Delete the old `pr-feedback-*.md` files (and
`.claude/.reviewlore-state.json`) before regenerating, or you
will keep the old, noisier rules next to the new ones.

### Changed — signal quality

Measured on a new labelled real-data eval (held-out repos express,
commander.js, swr): candidate precision 18.9% → 69.6%, recall
28.0% → 64.0%.

- **Comments on plain issues are no longer treated as PR review.** The
  issue-comments endpoint returns comments on issues too (bug reports,
  "can you assign this to me?"); they were 27–54% of issue-thread
  comments in the example repos and the largest source of junk rules.
  The fetcher now skips them, and `applySignals` drops them from older
  caches and committed corpora.
- **Classifier rewritten for precision.** Ambiguous triggers ("use",
  "prefer", "never", "avoid", "always", "try") only count at the start of
  a clause; hedges ("I don't know / think …" with no directive), status
  reports ("should be fixed"), and social requests ("please review",
  "assign it to me", "please see") are rejected. New coverage for bare
  imperatives ("Add a test for …"), "let's (not)", "X should be …",
  "we'll need …", "can be removed / is redundant", "can't have …",
  "why not …", "is this necessary?". Typographic apostrophes (`don’t`)
  now match.
- **Inline code is kept.** `` `code` `` spans are masked while
  classifying but kept in tokens and in quoted examples, so "Can you add
  `foo` to the type?" no longer renders as "Can you add a to the type?".
- **Clusters never mix "don't X" with "do X"**, and a cluster's kind
  (Avoid / Follow / Address) is the majority kind of its items instead of
  "any prohibition wins".
- **Labels are cleaner:** light plural folding (tests → test) merges
  near-duplicate clusters, and trigger/contraction fragments ("please",
  "don", "let") are stopwords.
- **Examples quote each comment once and prefer distinct reviewers.**
- **`codecov-commenter`, coveralls and sonarcloud** are treated as bots
  (they post as ordinary user accounts).

### Added

- **Real-data eval** (`eval/real/`, `npm run eval:real`): 540
  pseudonymised, hand-labelled comments from five public repos, with a
  dev / held-out split and CI floors. Both evals now run in CI and in the
  release workflow (the README previously claimed CI ran the eval; it
  didn't).

### Changed

- **`--llm` now defaults to `claude-sonnet-5-5`** (was `claude-sonnet-4-5`)
  and requests low effort. Requests opt into server-side fallback
  (`fallbacks: "default"`), so a cluster the model declines is retried
  on the default fallback model instead of failing. Refused or truncated
  responses are reported as per-cluster errors and fall back to
  heuristic rendering.
- **`@anthropic-ai/sdk` optional dependency bumped to `^1.3.0`** (was
  `^0.30.1`).
- **CI and release workflows** use `actions/checkout@v5` /
  `actions/setup-node@v5` (Node 24 runtime; the v4 actions ran on
  Node 20, which GitHub has removed from its runners). Test matrix is
  now Node 20 / 22 / 24; the publish job runs on Node 24. The bundled
  GitHub Action template is updated the same way and uses
  `peter-evans/create-pull-request@v8`.

### Fixed

- **Install instructions match reality.** README requirement corrected
  to Node ≥ 20.11 (it still said ≥ 18), and the quick-start demo uses
  the npm package instead of a `github:` spec that only works while the
  repo is public. Removed the duplicated "Try it in 5 seconds" section.
- **Docs no longer claim a ~95% prompt-cache hit rate for `--llm`.** The
  system prompt is shorter than the minimum cacheable prefix, so it has
  never been cached. Cost estimate in TROUBLESHOOTING.md updated.
- **Transitive vulnerabilities** in `@modelcontextprotocol/sdk`'s
  dependency tree (`npm audit`: 1 critical, 6 high, 2 moderate) resolved
  via `npm audit fix`; lockfile still resolves only from the public
  registry.
- **Project `.npmrc` pins `registry.npmjs.org`**, so a contributor's
  global or corporate npm config can no longer leak private mirror URLs
  into `package-lock.json` (the cause of the v0.2.1/v0.2.2 CI failures)
  or silently drop optional dependencies on install.

## [0.2.2] — 2026-06-04

### Fixed (infrastructure)

- **CI / publish pipeline now actually runs.** The v0.2.1 tag was cut
  but the release workflow never succeeded for two reasons (both fixed
  here):
  - `package-lock.json` recorded resolved URLs from a private npm
    mirror, inherited from the local `~/.npmrc`. GitHub Actions runners can't reach it; every
    `npm ci` failed with E401. Lockfile regenerated against the public
    npm registry.
  - Tests use `import.meta.dirname` (added in Node 20.11 / 21.2),
    which is `undefined` on Node 18, causing `resolve(undefined, …)`
    to throw `TypeError`. Dropped Node 18 from the CI matrix (EOL April
    2025); `engines.node` bumped to `>=20.11`.

### Changed

- `engines.node`: `>=18` → `>=20.11`.
- CI matrix node versions: `[18, 20, 22]` → `[20, 22]`.
- Release matrix node versions: `[18, 20]` → `[20, 22]`.

> The code changes that were intended to ship as v0.2.1 are all listed
> under [0.2.1] below — they are unchanged in this release; v0.2.2 just
> adds the CI/lockfile fixes so the npm publish can actually happen.

## [0.2.1] — 2026-05-20 (tagged but never published)

### Security
- **MCP path-traversal hardening** — `pr-comments-mcp` previously
  accepted `owner`/`repo` from MCP clients unvalidated and passed them
  to `path.join`, allowing a malicious MCP consumer to read any local
  `.json` file (npm/yarn lockfiles, VS Code settings, even credential
  stores). Inputs are now validated against the documented GitHub
  identifier grammar before forming any path.
- **Credential scanning before corpus publish** — `publishCorpus` now
  scans every PR-comment body for credential patterns (GitHub PATs,
  AWS keys, sk-ant keys, PEM blocks, Slack tokens) before writing the
  `.reviewlore-corpus.json` file. Default behaviour redacts
  matches with `[REDACTED]` and reports the affected PR URLs; the new
  `onSecrets: "refuse"` mode aborts entirely. Prevents secondary
  credential exfiltration when a token accidentally pasted into a PR
  comment gets bundled into `git log` forever via the committed corpus.

### Fixed
- **`sinceFromMonths` month-end drift** — the canonical JS Date trap.
  Subtracting 1 month from March 31 used to silently land in March 3
  (Feb 31 → normalised forward). Any toolkit run executed on the
  29th/30th/31st of a month silently skipped several days of comments.
  Now uses explicit UTC year/month arithmetic and clamps to the last
  valid day of the target month.
- **Diff mode silently unavailable via `reviewlore run`** —
  the diff-mode state file was only loaded/written by
  `pr-comments-to-skills`, not by the recommended `run` subcommand.
  Users running the orchestrator monthly never saw the
  added/strengthened/weakened/gone breakdown advertised in the README.
- **Config-supplied `preset` silently ignored** — `applyPreset` ran
  BEFORE `applyConfig`, so a wizard-saved
  `.reviewlore.json` containing `{ "preset": "team-of-50" }`
  never expanded into per-flag defaults. The documented precedence
  (CLI flag > config file > preset > built-in default) now holds.
- **`--target` failed in monorepo subdirectories** — auto-default
  used `existsSync(cwd/.git)`, which only succeeds at the repo root.
  Running from `packages/app/` failed with "--target is required"
  even though `--owner`/`--repo` had just been auto-detected. Now uses
  `git rev-parse --show-toplevel`, which walks up from any subdir.
- **`--months` validation missing in `run` subcommand** — bad input
  (`abc`, `6m`, `0`, `-3`) reached `Date.setMonth` and surfaced as a
  RangeError stack trace. Now caught with a clear error message.
  Stricter than parseInt: uses `Number()` so trailing junk like `6m`
  is rejected, not lenient-parsed to 6.

### Changed
- `publishCorpus` return shape extended with `warnings: [{ html_url,
  kind, labels }]` — programmatic API consumers can now surface
  redacted credentials to their own UI.
- `lib/diff.mjs` exports new helpers (`statePath`,
  `loadPreviousState`, `writeCurrentState`, `reportDiffSinceLastRun`)
  shared by both bins. Drops 30 lines of duplicated state logic from
  `bin/pr-comments-to-skills.mjs`.
- `lib/git-info.mjs` exports a new `findGitToplevel(cwd)` helper.

### Tests
- 178 → 203 (+25). Coverage added for: every credential pattern in
  `scanText`/`redactText`; `publishCorpus` redaction round-trip; the
  `refuse` mode; config+preset precedence; `--months` validation;
  `findGitToplevel` from root and subdirectory; diff-mode round-trip
  via `reviewlore run`; `sinceFromMonths` at four month-end
  boundaries (incl. leap year, year boundary, sub-3-month wrap).

### Security (round 2)
- **Cluster sort determinism** — `localeCompare` tiebreaks varied
  across host ICU locales (macOS/Linux/Alpine, `LANG` settings),
  silently producing different cluster orderings + different
  generated rules from the same input JSON. Replaced with binary
  codepoint compare so two machines agree byte-for-byte.

### Fixed (round 2)
- **Cache atomic write + lock** — two parallel `--cache` runs against
  the same `(owner, repo)` could interleave the read-modify-write
  window and silently lose one writer's data, or leave the JSON
  half-written (then `loadCache` returns null, the next run does a
  full window re-fetch and clobbers everything). Now writes via
  temp-file + atomic `rename(2)`, with an `O_EXCL` lock across the
  merge window. Stale-lock recovery after 30s so a crashed prior run
  doesn't wedge future ones.
- **`diffClusters` matching bijective** — when one previous cluster
  overlapped two current clusters (≥ MATCH_THRESHOLD Jaccard), BOTH
  matched it. The unmatched current never appeared as 'added' and the
  previous showed up in two tallies. Greedy assignment sorted by
  score descending now ensures each cluster on either side
  participates in at most one match.
- **Reviewer-rescinded drop too aggressive** — when the PR author
  opened a thread to self-annotate, a reviewer chimed in with real
  guidance, then the PR author closed with "nevermind", the whole
  thread (including the reviewer's substantive middle comment) got
  dropped. Now requires `root.author !== prAuthor` for the
  reviewer-rescinded branch.
- **Stale-corpus refresh workflow** — the documented `run` then
  `publish-corpus` monthly refresh was a silent no-op on second-and-
  later runs (`run` short-circuited on the corpus without touching
  the cache; `publish-corpus` then re-stamped last month's data).
  When `run` detects both a token AND a home cache, it now performs
  an incremental top-up fetch + merge so the next `publish-corpus`
  reflects the latest GitHub state.
- **Init wizard accepted typos in `--format`** — `claud`/`agent` /
  whatever was silently saved to `.reviewlore.json` and
  later failed at run-time with "Unknown format". New
  `askFormatList` validates each comma-separated token against the
  renderer registry, re-prompts on failure.

### Audit history
This release bundles fixes from two adversarial-multi-agent rounds:
the original `wy9ck0j89` audit (3 finders × 2 verifiers + completeness
critic — 31 surviving findings) and two fix-plan workflows:
`wzic65fga` (round 1, 6 patches) and the second round (6 more
patches). See `docs/audit-history.md` for the full finding → patch
mapping (12 of 31 survivors closed; 19 lower-priority items deferred
to v0.2.2).

## [0.2.0] — 2026-05-17

### Added

- **Portable corpus + `publish-corpus` subcommand** — one person fetches
  with a token, runs `reviewlore publish-corpus`, commits the
  resulting `.reviewlore-corpus.json` to the repo; every other
  teammate's `reviewlore run` auto-detects the corpus and runs
  with **zero auth, zero network, zero token**. Pass `--refresh` to
  force a re-fetch.
- **GitHub Action template updated** to publish the corpus on each run,
  so the bot owns the only token usage and humans never need one.

## [0.2.0] — 2026-05-17

### Added (UX round — agent-genericity, HTML, wizards, presets)

#### `reviewlore init` — interactive setup wizard
First-time setup is no longer "read 8 flags from the docs and guess." Run:

```bash
reviewlore init
```

…and answer ~7 questions (owner/repo guessed from `git remote`, target
dir, AI-tool format auto-detected, tuning preset, LLM y/n, lookback
window). Saved to `.reviewlore.json` in the target. Subsequent
`reviewlore run` invocations auto-load that config — no flags
needed for routine re-runs.

#### `--format html` — self-contained HTML report
A dashboard aimed at humans (tech lead, EM, new joiner) rather than
AI tools. Single self-contained file (`reviewlore-report.html`)
with inline CSS + vanilla JS — no build step, no CDN, works opened
from `file://` or hosted on GitHub Pages. Filter by severity / kind,
sort by recency or count, expand per-rule detail with source quotes.

#### `--format auto` and `--format a,b,c` — multi-format dispatch
- `--format auto` sniffs your target dir for `.claude/`, `.cursor/`,
  `.windsurfrules`, `CONVENTIONS.md`, `AGENTS.md`, etc., and picks
  every renderer that matches.
- `--format claude,html,agents` writes all three in one run.
- `--format all` emits every registered renderer (useful for
  cross-tool monorepos).

#### Three more AI-tool renderers
- `--format aider` — `CONVENTIONS.md` for Aider (`aider --read CONVENTIONS.md`).
- `--format agents` — `AGENTS.md`, the emerging cross-tool standard
  honoured by OpenAI Codex, Continue, and others.
- `--format windsurf` — `.windsurfrules` numbered-rule format for
  Codeium Windsurf.

The toolkit now ships **9 output formats** total. All use the same
managed-block pattern so re-runs don't clobber user-written content
outside the markers.

#### `--preset` — tuning profiles
Six named scenarios replace "what threshold should I use?":

- `team-of-3` — small team, loosens thresholds
- `team-of-50` — large team, tightens + enables semantic engine
- `oss-maintainer` — many drive-by reviewers
- `new-joiner` — long window, no time decay, "show me everything"
- `monthly-refresh` — tight window + recency bias for cron runs
- `exploratory` — loosest thresholds + semantic engine

Each preset fills in 4-6 individual flags; explicit flags still override.

#### `--time-decay-half-life` — recency weighting
Optional weighting where a comment from N months ago counts as
0.5^(N/halfLife). Default off; presets opt in where appropriate
(e.g. `monthly-refresh` uses 1-month half-life).

#### Cluster recency + canonical Rule schema
Every cluster now exposes `firstSeen` / `lastSeen` ISO timestamps.
A new `lib/renderers/_common.mjs` exports `normalizeRule(cluster, synth)`
→ canonical `Rule` shape (id, title, body, why, when_to_apply, severity,
globs, examples, source, …). Future renderers consume `Rule[]` directly
instead of re-deriving fields from raw cluster items.

#### New `reviewlore` one-shot CLI
The simplest path is now a single command:

```bash
reviewlore run --owner facebook --repo react --target ~/code/react
```

Fetches, clusters, and writes skill files in one go. Uses your existing
`gh auth login` token if you have the GitHub CLI installed. The three
individual sub-bins (`fetch-pr-comments`, `pr-comments-to-skills`,
`pr-comments-mcp`) remain for power users.

#### Five output formats via `--format`
The toolkit is no longer Claude Code-only. Pick the format that matches
the tool you actually use:

- `claude` (default) — `.claude/rules/pr-feedback-*.md`, one file per rule.
- `cursor` — `.cursor/rules/pr-feedback-*.mdc` with YAML frontmatter
  (description + globs auto-derived from the cluster's file paths).
- `copilot` — single `.github/copilot-instructions.md` with a managed
  block. Surrounding prose is preserved on re-runs.
- `contributing` — appends a managed "Recurring review feedback"
  section to `CONTRIBUTING.md`. Tool-agnostic.
- `json` — machine-readable `reviewlore-rules.json` for
  downstream tooling.

#### `--demo` mode — try in 5 seconds with no setup
```bash
npx -p reviewlore pr-comments-to-skills --demo
```
Runs the full pipeline against a bundled synthetic fixture and prints
generated rules to stdout. No GitHub token, no input file, no target
needed.

#### GitHub CLI token fallback
If you've already run `gh auth login`, the toolkit picks up the token
automatically. No `--token` flag, no `GITHUB_TOKEN` env var, no PAT to
create. Token resolution order: `--token` flag > `GITHUB_TOKEN` env >
`gh auth token`.

#### Optional Claude-synthesised rules via `--llm`
Pass `--llm` to `pr-comments-to-skills` (or the orchestrator) and each
cluster gets a proper title, generalised rule, technical rationale,
and "when to apply" clause written by Claude — instead of the
shortest source quote. Prompt-cached; typically a few cents per run.
Requires `@anthropic-ai/sdk` (optionalDependency) and
`ANTHROPIC_API_KEY`.

#### Smarter signal filtering
Before clustering, the toolkit now:
- **Drops PR-author self-comments** (those are explanations, not
  reviewer feedback).
- **Drops resolved review-comment threads** — if the PR author replied
  "fixed / good catch / done" the rule's already enforced in the code.
- **Weighs comments by review state**: comments in
  `CHANGES_REQUESTED` reviews (which actually blocked merge) count
  twice as much as comments in `APPROVED` reviews.

#### Incremental cache + re-run diff
Pass `--cache` (or use the orchestrator, where it's default) and the
toolkit writes to `~/.reviewlore/<owner>__<repo>.json`. The
next run only fetches what's new. `pr-comments-to-skills` also persists
a tiny state file in `.claude/`; on re-run, it prints a diff showing
which rules are **new**, **strengthened**, **weakened**, or **gone**
since the last run.

#### MCP server (`pr-comments-mcp`)
Third bin that exposes the cached corpus to Claude Code (or any MCP
client) as queryable tools (`list_repos`, `search_rules`,
`recent_feedback`). Solves the "30 rule files flood every context"
problem — Claude pulls only what's relevant to the current path/topic.

#### Semantic clustering engine
New `--engine semantic` uses TF-IDF cosine instead of Jaccard. Rare
tokens (like `any` or `unknown` in a TypeScript codebase) get higher
weight than common ones. Default stays Jaccard for backward
compatibility.

#### Evaluation harness
`npm run eval` benchmarks each clustering engine against labeled
fixtures and reports precision / recall / F1. CI gate prevents
regressions on future changes.

#### Documentation
- `README.md` — full technical reference (rewritten).
- `OVERVIEW.md` — plain-English product story for non-implementers.
- `TROUBLESHOOTING.md` — common errors and resolutions, including
  authentication setup.
- `docs/audit-history.md` — internal record of what was found in each
  audit pass and why each fix landed.

### Changed
- Progress logger is TTY-aware. In CI logs and pipes, each message
  gets its own line instead of writing ANSI clear-line escapes.
  Honours `NO_COLOR`.
- Clustering is now deterministic — identical input produces identical
  output across runs and across machines.
- Clustering compares new items against each cluster's compact
  centroid instead of its growing token union; prevents "topic drift"
  where one cluster absorbs unrelated items.
- CI matrix installs `jq` defensively on both Ubuntu and macOS
  (previously macOS-only).
- Release workflow blocks publish if the pushed git tag doesn't match
  `package.json`'s version.

### Fixed
- The most common reviewer pattern in typed-language repos — "avoid
  `any` types" — was silently dropped because `any` was treated as a
  stopword. Kept; sparse-remainder candidates now fall back to
  tokenizing the full sentence.
- `--token` with no value (e.g. trailing on the command line) silently
  authenticated as the literal string `true`. Now errors with a clear
  "Missing value for --token" message.
- `--out --per-month` (and similar boolean-as-value typos) used to
  swallow the boolean flag. Now errors.
- YAML frontmatter in generated rule files broke on colons or newlines
  in the source sentence. All values now properly quoted.
- Crisp comments like `Use \`foo()\` not \`bar()\`.` were dropped as
  "too short" because the noise filter measured length *after*
  stripping inline code. Now measures raw body length.
- Numeric flags (`--min-occurrences`, `--min-authors`, `--threshold`)
  silently produced empty output on non-numeric input. Now errors.
- One verbose reviewer writing the same point three times in one PR
  counted as 3 occurrences. Now counts as 1 — uses unique
  `(author, pr)` tuples.
- Re-running the generator silently overwrote rule files you'd
  hand-edited. Now skips existing files unless `--force`.

### Breaking
- The programmatic `writeSkills()` API return shape changed from
  `Array` to `{ written, skipped }`. Only affects direct library
  consumers; the CLI is unchanged.

## [0.1.0] — 2026-05-16

Initial release.

- `fetch-pr-comments` CLI — fetches issue comments, inline review
  comments, and review submissions over the last N months.
- `pr-comments-to-skills` CLI — heuristic clustering of recurring
  reviewer feedback into `.claude/rules/pr-feedback-*.md` files with
  citations to source PRs.
- 10 lib modules, 38 tests, pre-publish audit suite
  (`check-pack` / `check-secrets` / `smoke-test`), CI matrix on
  Ubuntu + macOS × Node 18/20/22, release workflow with npm provenance
  attestation, MIT license.

[Unreleased]: https://github.com/cloudhobbit/reviewlore/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/cloudhobbit/reviewlore/releases/tag/v0.3.0
[0.2.2]: https://github.com/cloudhobbit/reviewlore/releases/tag/v0.2.2
[0.2.1]: https://github.com/cloudhobbit/reviewlore/releases/tag/v0.2.1
[0.2.0]: https://github.com/cloudhobbit/reviewlore/releases/tag/v0.2.0
[0.1.0]: https://github.com/cloudhobbit/reviewlore/releases/tag/v0.1.0
