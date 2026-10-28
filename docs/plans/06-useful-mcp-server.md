# 06 — An MCP server worth keeping on

**Priority:** P1 · **Effort:** M (≈ 4–5 days, estimate) · **Depends on:** none (09 reuses its index module; pairs with 10)

_Status (October 2026): implemented. Changes from this design, found
while building it on live data: stem-based prefix matching (the
`len - 2` rule missed "validation" → "validate"); "same package" falls
back to the first two directory levels; requests get a small ranking
boost (gallery check 9/14 → 10/14); caches over 20 MB are indexed in a
child process (the server otherwise kept ~1.1 GB on pnpm); replies in
bot-started threads are excluded. Real tool-call rates in sessions are
still unmeasured._

## Problem

The plugin turns on an MCP server, but in daily use it rarely helps. Every
tool needs `owner` and `repo`, even inside the repo. Searching for the most
important pnpm convention ("changeset") returns nothing. With Claude Code's
default tool search, Claude sees only three generic tool names and no
server instructions, so it has no reason to call them before editing a
file. Plugins that go unused for 14 days and 10 sessions are shown as "Not
used recently" (https://code.claude.com/docs/en/plugins/measure.md), so an
MCP server that sits idle costs us users.

## Audit findings

Code (tip 4ae24bc):

- `lib/mcp-tools.mjs:13-19` `loadData(owner, repo, cwd = process.cwd())`
  reads the user cache, then a committed corpus in `process.cwd()` only.
  It never looks at the git top level, `CLAUDE_PROJECT_DIR` or MCP roots.
  It re-reads and re-parses the file on every call. There is no memo.
- `lib/mcp-tools.mjs:45-82` `searchRules` re-runs `extractCandidates` →
  `buildClusters` → `filterClusters({minOccurrences: 2, minAuthors: 2})`
  per call, then filters by **substring** match of each topic word
  (`h.includes(n)`, line 63). A topic with a short word matches everything:
  `"add a changeset"` has the needle `"a"` and returned the unrelated
  clusters `code/duplicate` and `fix/instead` on pnpm (measured).
- `lib/mcp-tools.mjs:84-109` `recentFeedback` filters by path prefix,
  `isNoise` and the PR author, then sorts by date. Thread replies are not
  collapsed, resolved threads are not dropped (`applySignals` isn't used),
  and the tool has no ranking or de-duplication. pnpm has 843 of 3,364
  review comments with `in_reply_to_id`.
- `lib/mcp-tools.mjs:114-183`: every tool requires `owner` and `repo`, and
  the descriptions are one-liners. `bin/commands/mcp.mjs:73-76` builds
  `new Server({name, version}, {capabilities})` with no `instructions`,
  although SDK 1.32.2 supports it (`server/index.d.ts:15`).
- `lib/git-info.mjs:11-26` `detectRepoFromGit` and `findGitToplevel` already
  exist and are best-effort with a 1.5 s timeout. Reuse them.
- `test/mcp-tools.test.mjs` covers listRepos, the hint, thresholds and the
  topic filter, using `REVIEWLORE_CACHE_DIR` temp dirs. It has no
  project-dir tests and no corpus-fallback tests through the git top level.

Measured offline on cached corpora (scratch scripts, read-only cache):

| corpus | size | read | parse | extract | cluster | candidates | 2/2 clusters |
|---|---|---|---|---|---|---|---|
| pnpm | 17.2 MB | 24 ms | 28 ms | 40 ms | 14 ms | 382 | 3 |
| vitest | 7.2 MB | 9 ms | 13 ms | 40 ms | 24 ms | 560 | 10 |
| express | 1.2 MB | 1 ms | 2 ms | 37 ms | 16 ms | 368 | 3 |

- That is about 106 ms per `search_rules` call on pnpm, half of it I/O and
  parsing. Heap after `JSON.parse` is 59 MB. A slim index (human, non-author
  comments without `diff_hunk`/`updated_at`, plus candidates) is 9.5 MB.
- **"changeset" on pnpm:** the old `search_rules` finds 0 clusters. BM25 over
  candidates finds 5 hits on 5 PRs, all from one reviewer. A regex over all
  human comments finds 10 comments on 10 PRs by 4 authors, some of them
  not requests. The plugin's own rule
  (`examples/real-repos/pnpm/plugin/.claude/rules/pr-feedback-add-a-changeset.md`)
  cites 4 quotes from 3 reviewers, and **2 of them never contain the word
  "changeset"**. No lexical search can recover that support. Only the
  synthesised rule file holds it.
- **Gallery check.** I used each gallery rule's title as the query and BM25
  (k1 = 1.2, b = 0.75) over all 2,055 / 2,455 / 2,956 human review sentences
  (pnpm / vitest / express, after `applySignals`), with prefix expansion for
  words of 5 or more letters. At least one cited quote reached the top 5 for
  **9 of 14 rules**. The old `search_rules` scored 5 of 14, a generous count
  because of the substring bug. Cited-quote recall in the top 5 was 11 of 46.
  Titles were written from those quotes, so this is optimistic.
- BM25 query time is 0.1–0.2 ms and the index builds in about 1 ms once
  candidates exist.

Docs (verified 2026-10-27):

- Tool search is on by default. "Only tool names and server instructions
  load at session start". Server instructions should say "what category of
  tasks your tools handle" and "when Claude should search for your tools".
  The limits are 4,096 characters for instructions and upfront tools, and
  16,384 for deferred tool descriptions. Put the search words near the
  start. `_meta["anthropic/alwaysLoad"]: true` loads one tool upfront
  (https://code.claude.com/docs/en/mcp#scale-with-mcp-tool-search).
- Output above 10,000 tokens triggers a warning. Above 25,000 tokens or
  50,000 characters, the result is saved to a file (same page, "MCP output
  limits").
- Working directory: the docs **don't state** the cwd of a stdio server. For
  `headersHelper`, a plugin's working directory is "the plugin's root
  directory". If that also holds for the server process, the current
  committed-corpus fallback (`process.cwd()`) **never finds the user's
  corpus in plugin mode**. This is unverified and needs a manual check. The
  MCP page says Claude Code sets `CLAUDE_PROJECT_DIR` in a stdio server's
  environment. The plugin reference table lists only `CLAUDE_PLUGIN_ROOT`
  and `CLAUDE_PLUGIN_DATA` as exported to MCP servers, but says
  `${CLAUDE_PROJECT_DIR}` is substituted in `command`, `args` and `env`
  (https://code.claude.com/docs/en/plugins-reference#environment-variables).
  The two pages conflict, so we pass the path explicitly. `roots/list`
  returns the session launch directory plus added directories.
- Path-scoped rules load only when Claude Reads, Writes or Edits a matching
  file (https://code.claude.com/docs/en/memory#path-specific-rules). Grep
  and planning steps don't load them, which is the gap the MCP server can
  fill.

Not verified: real tool-call rates in Claude Code sessions, and the
server's actual cwd. Both need a manual session with `claude --debug`.

## Goals / Non-goals

Goals: zero-argument tools inside the repo; search that finds paraphrased
conventions; a ranked, de-duplicated "what have reviewers said about this
area" tool; warm calls under 5 ms; descriptions and instructions that lead
Claude to call the tools before editing reviewed code.

Non-goals: embeddings or new dependencies, network calls from the server,
writing files, and replacing rules. The server stays read-only and offline.

## Options considered

1. **Keep clusters, fix the topic filter.** Cheap, but 2/2 clusters are
   rare (3 on pnpm), so search stays mostly empty.
2. **Three-tier lexical index (chosen).** (a) Rule files in the project's
   `.claude/rules/`, which hold synthesised, paraphrase-merged conventions
   with URLs. (b) Extracted candidates, which carry kind. (c) All human
   review sentences as a fallback. Rank with BM25 plus prefix expansion,
   and report honest support counts (PRs, reviewers) for what matched. No
   dependencies, deterministic, sub-millisecond queries.
3. **Semantic engine at query time** (`lib/similarity.mjs` TF-IDF) or
   embeddings. TF-IDF is still bag-of-words, and embeddings need a
   dependency or API key. Rejected for now. Revisit if the gallery metric
   stays below 12 of 14.

## Design

**New module `lib/review-index.mjs`** (pure, no I/O except through
injected loaders):

```js
buildIndex(data, { rules = [] }) → Index      // slim comments, candidates, BM25 postings, rule docs
searchIndex(index, query, { path, limit = 8 }) → { results, support, rules }
feedbackForPath(index, path, { months = 12, limit = 8 }) → { rules, comments, more }
```

- `tokenize` comes from `lib/patterns.mjs`. Query words of 5 or more
  letters expand to vocabulary words sharing a prefix of
  `max(5, len - 2)` letters (`deprecat` → `deprecated`). Ties break by
  `created_at` descending, then URL, using a binary compare as in
  `lib/cluster.mjs`.
- Comments are built from `applySignals(data)` (which drops plain-issue
  comments, PR-author replies and resolved threads), then `isNoise`.
  `diff_hunk` and `updated_at` are dropped.
- Rule docs: parse `.claude/rules/**/*.md`, reading the `paths` frontmatter,
  the title, the body text and every `https://github.com/...` URL. Rule hits
  are listed first and labelled `source: "rule"` with `generated:
  true/false` (detected by the `reviewlore` provenance comment;
  plan 10 formalises this).
- Results are grouped one per source comment (URL). `support = {prs,
  reviewers}` is computed over the top `limit` results only, so "1
  reviewer" shows plainly.

**Repo resolution, `resolveContext(args)`**, in order:

1. Explicit `owner`/`repo` (still validated with `NAME_RE`).
2. Project dir, from `REVIEWLORE_PROJECT_DIR` (set by plugin.json, see
   below), then `CLAUDE_PROJECT_DIR`, then the first `file://` root from
   `server.listRoots()` (cached, refreshed on `roots/list_changed`), then
   `process.cwd()`.
3. `findGitToplevel(projectDir)` → `detectRepoFromGit` → owner/repo. If that
   fails, use the committed corpus's `meta.owner/repo`.
4. Data: the user cache, unless the committed corpus is newer
   (`meta.fetched_at`). The response says which source and how old
   (`source: "cache" | "corpus"`, `age_days`).

plugin.json gains `"env": { "REVIEWLORE_PROJECT_DIR": "${CLAUDE_PROJECT_DIR}" }`
on the `reviewlore` server.

**Caching.** A module-level `Map` keyed by absolute data path holds
`{mtimeMs, size, index}`. Each call runs `statSync` and rebuilds only when
mtime or size changed. The raw parsed JSON is released after the build, so
the heap holds about 10 MB on pnpm. No disk cache, because the server
process is long-lived and a cold build is about 106 ms.

**Tools.** Names put the search words first. The old names stay as aliases
for one minor version and return their old shapes.

| tool | args (all optional unless noted) | returns |
|---|---|---|
| `review_feedback_for_path` | `path` (required), `owner`, `repo`, `months` = 12, `limit` = 8 | matching rules (globs match `path`), then human comments ranked by: exact file > same dir > same package scope (`pathGlobs`), then kind (request/prohibition > prescription > question > other), then recency. Threads collapse to the root comment with `replies: n`. Near-duplicates (token Jaccard ≥ 0.8, same author) are merged. |
| `search_review_feedback` | `query` (required), `path`, `owner`, `repo`, `limit` = 8 | rules first, then BM25 results with `support`. |
| `list_repos` | — | unchanged, plus `default: true` for the resolved repo |

Quotes are capped at 400 characters. Each result is
`{quote, author, pr, url, path, line, kind, created_at, source}`. The
response stays under about 4k tokens at the defaults (guard: truncate and
set `more: n`).

**Server instructions** (draft, about 700 characters, key words first):

> Pull-request review history for the current repository: what human
> reviewers asked for on past PRs, with links. Before editing or adding
> code in a directory, call `review_feedback_for_path` with that path to
> see recurring reviewer requests and the repo's review-derived rules.
> Use `search_review_feedback` to check a convention ("changeset",
> "error messages", "snapshot tests") before proposing it. Results quote
> real comments; treat a single reviewer's comment as context, not a rule.

Set `_meta["anthropic/alwaysLoad"]: true` on `review_feedback_for_path`
only. That costs one schema upfront, roughly 150 tokens (estimate).

## Implementation steps

1. `lib/review-index.mjs`: build, search, path feedback, rule-file parser
   (frontmatter `paths`, title, URLs).
2. `lib/mcp-tools.mjs`: add `resolveContext`, the memo cache, the new tools
   and the aliases. Make `owner`/`repo` optional in the schemas. Keep
   `validateArgs`.
3. `bin/commands/mcp.mjs`: pass `instructions`, add `_meta`, implement
   `listRoots` lookup and the `roots/list_changed` handler. Update HELP.
4. `.claude-plugin/plugin.json`: add `env.REVIEWLORE_PROJECT_DIR`.
5. `test/review-index.test.mjs` (new) and `test/mcp-tools.test.mjs`
   (extend). `scripts/check-pack.sh`: add the new lib file to REQUIRED.
6. Docs and changelog (below).

## Tests & verification

- Unit tests (hermetic, temp dirs, no network): BM25 ordering and
  determinism (same input, byte-identical JSON); prefix expansion;
  thread collapse; resolved-thread exclusion; near-duplicate merge;
  rule-first ordering and glob matching; `"add a changeset"` no longer
  matches unrelated fixtures (regression for the substring bug).
- Resolution: a temp dir with `git init` and `git remote add origin
  git@github.com:o/r.git` (local git, offline), the corpus at the top level,
  and the server started in a subdirectory. Also env precedence
  (`REVIEWLORE_PROJECT_DIR` over `CLAUDE_PROJECT_DIR` over cwd), and the
  memo rebuilding after `utimesSync`.
- Eval: add `eval/search-gallery.mjs`, run manually because it reads the
  local cache. It computes the gallery metric above (rule title as query,
  rules tier off). Today it is 9 of 14 with ≥ 1 cited quote in the top 5,
  and 11 of 46 cited quotes. It is not in CI because the cache isn't
  committed.
- Manual: `claude --debug` with the plugin from a local marketplace. Log
  `process.cwd()` and the env at startup to stderr, and record the real cwd
  and whether `CLAUDE_PROJECT_DIR` arrives. Then ask "add an option to the
  pnpm config package" and check whether the tool is called before the
  first Edit.

## Docs & changelog

`docs/cli.md#mcp` (new tool table, optional owner/repo, aliases),
`README.md` plugin section (one sentence on what the server does),
`docs/how-it-works.md` (index tiers), `CHANGELOG.md [Unreleased]`
(Added / Changed / Deprecated aliases).

## Risks, compatibility & rollback

- Old tool names stay as aliases until 0.4.0. Clients that pass
  `owner`/`repo` keep working.
- Rule files from other tools may have odd frontmatter. The parser must be
  forgiving: a parse failure skips the rule's globs, with no crash.
- If `alwaysLoad` proves noisy, drop the `_meta` key, which is a one-line
  rollback.
- Memory: about 10 MB per indexed repo. With several repos cached, keep at
  most 3 indexes (LRU).

## Cross-cutting checks

- **Credentials:** none read. The server never resolves a GitHub token.
- **Privacy:** the server returns handles and quotes that are already in
  the cache or corpus, and writes nothing.
- **Determinism:** binary compares, stable tie-breaks, no `Date.now()` in
  ranking except the explicit `months` cutoff (passed `now` in tests).
- **Dependencies:** none new.
- **stdout/stderr:** stdout is the MCP protocol. Debug logs go to stderr
  only, behind `REVIEWLORE_DEBUG`.
- **Windows:** use `path.posix` for repo paths from GitHub and normalise
  `\` in the `path` argument. Not tested in CI (no Windows runner).
- **Plugin vs CLI:** the same `lib/review-index.mjs` serves plan 09's
  `precedents` command.

## Success metrics

- Zero-argument calls work from the repo root and from a subdirectory
  (test).
- Warm call p95 under 5 ms on the pnpm corpus. Cold call at or below today's
  110 ms.
- Gallery metric at least 9 of 14 lexical-only, and 14 of 14 with the rules
  tier on, where each rule finds itself.
- Manual session: the tool is called before the first edit in at least 3 of
  5 scripted tasks that touch reviewed directories (baseline to be measured
  first).

## Open questions for the owner

1. Should we ship `alwaysLoad` on by default, or wait for the manual
   tool-call measurement?
2. Should the server index hand-written rules too (it reads them anyway),
   or only `pr-feedback-*`?
3. Is a `PreToolUse` hook on Edit/Write worth trying as an opt-in follow-up?
   It would inject the top 2 precedents for the file being edited. It is
   deterministic but adds per-edit latency and noise.
