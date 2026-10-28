# 05 — Slim, diff-friendly committed corpus

**Priority:** P1 · **Effort:** S–M (≈ 2–3 days, estimate) · **Depends on:** none (pairs with 03 for the `meta.since` fix and Actions cache seeding; 06's in-memory index is a separate concern)

## Problem

`publish-corpus` copies the whole home cache into the repo. For pnpm that
is a 16.4 MiB JSON file, 62 % of it bot comments and another third
`diff_hunk` code, that teammates must clone and every refresh rewrites as
thousands of changed lines. It also commits hundreds of reviewer handles
and unscanned diff code that the toolkit never uses. Maintainers who look
at the file size or the PR diff decide not to commit it, so teammates fall
back to needing a token.

## Audit findings

Measured on the five cached corpora in `~/.reviewlore/` (read-only
copies in scratch; offline CLI with `GITHUB_TOKEN=` and an empty
`REVIEWLORE_CACHE_DIR`). Sizes are bytes as written by `publish-corpus`
(pretty-printed, `lib/corpus.mjs:112`).

| repo | full | slim (chosen rule) | slim, one record per line | slim gzip | records kept | handles kept |
|---|---|---|---|---|---|---|
| pnpm | 16,811 KB | 1,169 KB | 981 KB | 213 KB | 2,005 / 8,623 | 112 / 687 |
| vitest | 7,049 KB | 1,081 KB | 921 KB | 213 KB | 1,742 / 6,154 | 98 / 425 |
| express | 1,202 KB | 509 KB | 458 KB | 126 KB | 601 / 1,384 | — |
| commander.js | 381 KB | 75 KB | 63 KB | 15 KB | 134 / 535 | — |
| swr | 326 KB | 12 KB | 10 KB | 4 KB | 19 / 170 | — |

- **The brief's rule changes output.** Keeping only human, PR, ≥ 20-char
  comments (the rule behind "1.17 MB") gives pnpm 1,289 KB, but
  `candidates` output changes: pnpm 382 → 397 candidates, 367 → 379
  clusters; vitest 560 → 568 / 520 → 528. MCP `search_rules` /
  `recent_feedback` results also differ (27 calls compared). The cause is
  resolved-thread detection (`lib/signals.mjs:74-128`): it reads the
  *last* reply in each `in_reply_to_id` chain, and that reply is usually a
  short "Done" / "fixed" from the PR author (< 20 chars, so `isNoise`) or a
  bot. Dropping those resurrects threads the author already resolved.
- **A thread-preserving rule is exact.** Rule (see Design): drop noise,
  plain-issue and PR-author self-comments, but keep every review comment
  that is part of a reply chain, cutting the body of noisy chain members
  to the resolution keyword. On all five repos `candidates` stdout and
  `run --dry-run` stdout are byte-identical to the full corpus, and all 27
  MCP calls return identical JSON. The scratch scripts (not in the repo) were
  `slim.mjs` (variant `plus`) and `verify.mjs` in the session scratchpad
  `plans-data/` folder; step 2's module replaces them.
- **`eval:real` cannot catch this.** On slimmed records, dev 90.9 % / 85.7 %
  and held-out 69.6 % / 64.0 % are unchanged for *both* rules: the eval is
  built from 540 sampled comments (`eval/run-real-eval.mjs:42-60`) with
  few complete threads. A corpus-level golden test is needed.
- **Field usage.** In the pnpm full corpus, `body` is 7.9 MB, `diff_hunk`
  5.4 MB, `html_url` 0.66 MB, `updated_at` 0.21 MB, `pr_title` 0.18 MB.
  `diff_hunk`, `updated_at` and `pr_title` are written by
  `lib/fetchers.mjs:32,54,57,106` and read nowhere in `lib/` or `bin/`.
  These fields are needed: `in_reply_to_id`, `author`, `created_at` and
  `meta.pr_authors` (signals); `state` and `submitted_at` (weights,
  `signals.mjs:159`); `path`, `line`, `html_url` (candidates globs/quotes,
  MCP `recent_feedback`, `lib/mcp-tools.mjs:91-107`); `author_type`
  (`normalize.mjs:89`).
- **Secret scan covers `body` only** (`lib/secret-scan.mjs:63-66,76`). The
  5.4 MB of `diff_hunk` code and `pr_title` are published unscanned
  today. Dropping them removes that channel.
- **Diff noise.** Simulated refresh (pnpm slim corpus without vs with its
  last month): pretty-printed output changes 6,933 lines, while sorted
  one-record-per-line output changes 544.
- **The corpus records the wrong window.** `mergeIntoCache` spreads
  `freshOutput.meta` over the existing meta (`lib/cache.mjs:68-73`), so
  after any incremental fetch `meta.since` is the incremental cutoff.
  Reproduced in scratch: a 6-month cache topped up with a 7-day fetch
  reports `since` = 7 days ago. `publish-corpus` copies it, `candidates`
  prints it (`bin/reviewlore.mjs:554`), and rule summaries show
  it (`lib/skill-writer.mjs:178`).
- **A corrupt corpus crashes `run` / `candidates`.** `corpusInfo` returns
  `{ path, error: "corrupt" }` (`lib/corpus.mjs:57-58`). The caller then
  reads `corpusOnDisk.totals.total` (`bin/reviewlore.mjs:332`)
  and throws a `TypeError`. Reproduced with a file containing git conflict
  markers, which is exactly what a refresh merge conflict produces.
- Other facts: the corpus is parsed twice per run (`corpusInfo` and
  `loadCorpus`). `candidates` on pnpm takes 0.33 s with the full corpus
  and 0.19 s with the slim one. MCP prefers the home cache over the corpus
  (`mcp-tools.mjs:13-19`), so the cache can stay full.
  `candidates.stats.comments` comes from `meta.totals.total`
  (`bin/reviewlore.mjs:556`).
- Not verified: how git delta-compresses successive corpus versions in a
  real repo's history (packfile sizes were not measured).

## Goals / Non-goals

Goals: a committed corpus about 10× smaller for busy repos; byte-identical
`candidates`, `run` and MCP output from it; small, reviewable refresh
diffs; old corpora still readable; older toolkit versions can still read
new corpora.

Non-goals: shrinking the home cache (it stays the full source of truth),
a binary or indexed format (see plan 06), changing extraction heuristics.

## Options considered

1. **Brief's filter** (human, PR, ≥ 20 chars, drop `diff_hunk` /
   `updated_at`). Simple, but it changes output (above). Rejected.
2. **Thread-preserving slim, plain JSON with one record per line,
   sorted.** Exact output, about 1 MB for the busiest repos, small diffs,
   readable by every toolkit version and by `grep` / `jq`. **Chosen.**
3. **Option 2 plus gzip (`.json.gz`).** About 210 KB on disk, but:
   - git already zlib-compresses blobs, so history cost is similar
     (unmeasured);
   - every refresh becomes an opaque binary diff, so reviewers cannot see
     what was added or check for leaked secrets in the PR;
   - `loadCorpus`, `corpusInfo` and MCP `listRepos` all assume `.json`;
   - toolkit 0.2.x would ignore the file and ask for a token.

   Rejected. It could be reconsidered as an opt-in flag if a repo exceeds
   about 5 MB slim.

## Design

**Slim rule** (new pure module `lib/slim.mjs`, `SLIM_VERSION = 1`):

1. `issue_comments`: drop `isPlainIssueComment`, drop `isNoise`, and drop
   comments whose author is `meta.pr_authors[pr_number]` (PR-author
   self-comment).
2. `review_submissions`: drop `isNoise` and PR-author self-comments.
3. `review_comments`: a comment is a *thread member* if it has
   `in_reply_to_id` or another comment replies to it. Keep every thread
   member. If a thread member is noise, set its `body` to the first match
   of the two resolution regexes, or `""` if neither matches. Drop other
   review comments if they are noise or PR-author self-comments.
4. Drop the fields `diff_hunk`, `updated_at` and `pr_title`. Keep `type`,
   ids, `pr_number`, `author`, `author_type`, `body`, `path`, `line`,
   `in_reply_to_id`, `created_at` / `submitted_at`, `state` and
   `html_url`.
5. Prune `meta.pr_authors` to the PR numbers still referenced. This is
   exact, because lookups only use the `pr_number` of present records,
   and it drops most of pnpm's 969 PR → author entries (not
   re-measured).
6. Export the resolution regexes from `signals.mjs` (no copy), so both
   modules share them.

`slimCorpus` is idempotent: `slim(slim(x))` equals `slim(x)`.

**File format** (still `.reviewlore-corpus.json`, valid JSON):

```
{"meta":{"schema_version":2,"owner":"pnpm","repo":"pnpm","fetched_at":"…","since":"<coverage start>",
 "months_back":6,"totals":{…kept…},"source_totals":{…as fetched…},"pr_authors":{…pruned…},
 "slim":{"version":1,"dropped":{"bot":…,"plain_issue":…,"short_or_praise":…,"pr_author":…}}},
"issue_comments":[
{"type":"issue_comment","comment_id":1,…},
…],
"review_comments":[
…],
"review_submissions":[
…]}
```

- Each record is on its own line. Arrays are sorted by
  (`created_at` | `submitted_at`, id) and keys are in a fixed order. The
  output is deterministic: same input, same bytes.
- `meta.since` is the coverage start. 03 adds `coverage_from` to the
  cache; until then, `publish-corpus` uses the minimum of the cache's
  first `since` and the earliest record date. `mergeIntoCache` stops
  overwriting `since` (fixed here or in 03, whichever lands first).
- `candidates.stats.comments` reads `source_totals.total ?? totals.total`,
  so the number users see does not drop by 4×.

**Readers.** `schema_version` absent means v1: read as today. v2 is read
the same way (same arrays and fields), so no code path branches except
`stats.comments`. Old toolkit versions read v2 as an ordinary corpus.

**Writer.** `publishCorpus` loads the cache, applies `slimCorpus`, then
redacts and serialises. Redacting after slimming scans fewer bodies, and
every published string field is either a scanned body or a structural
field. Add a `path` scan as well: file paths can contain tokens in
generated fixtures. This is rare and cheap. `--full` keeps today's
behaviour for anyone who needs `diff_hunk` (escape hatch; open question
whether to ship it).

**Robustness.** In `run`, `candidates` and MCP, a corpus with
`error: "corrupt"` gets a one-line warning ("`.reviewlore-corpus.json`
is not valid JSON (merge conflict?) — ignoring it; re-run
`publish-corpus --force`") and the command falls through to the cache or
fetch path. `corpusInfo` returns the parsed object, so the file is read
once.

## Implementation steps

1. `lib/signals.mjs`: export the resolution regexes. No behaviour
   change.
2. `lib/slim.mjs` (new): `slimCorpus(data) → { data, stats }`,
   `SLIM_VERSION`, `serializeCorpus(data)` (sorted, one record per line).
   Add it to `scripts/check-pack.sh` REQUIRED.
3. `lib/corpus.mjs`: `publishCorpus` slims, redacts, serialises, and
   reports `{ sizeKb, sourceSizeKb, dropped }`. `corpusInfo` returns the
   parsed data and `schemaVersion`. Add a `path` scan in
   `lib/secret-scan.mjs` `forEachComment`.
4. `bin/reviewlore.mjs`: guard the corrupt-corpus path (around
   :323-336) and reuse the parsed corpus. `stats.comments` falls back to
   `source_totals`. The publish message shows
   "16.4 MB cache → 1.1 MB corpus (dropped 3,966 bot / … comments)".
5. `lib/cache.mjs`: keep the existing `meta.since` on merge (coordinate
   with 03).
6. `examples/github-action/regenerate-rules.yml`: no change needed; the
   size drop comes automatically with `--force`.
7. Docs and CHANGELOG (below).

## Tests & verification

- `test/slim.test.mjs`, hermetic fixtures:
  - a resolved thread whose last reply is a 5-char "Done" by the PR
    author stays resolved after slimming;
  - a bot thread root plus a human reply keeps its structure;
  - PR-author self-comments are dropped;
  - plain-issue comments are dropped;
  - idempotence;
  - the dropped fields are absent;
  - `pr_authors` is pruned;
  - serialisation is deterministic, sorted, and the same bytes on a
    second run.
- **Golden equivalence test:**
  - Commit a small synthetic corpus (about 60 records, threads, bots,
    issues) to `test/fixtures/` and assert that `extractCandidates` →
    `buildClusters` → `filterClusters` gives identical results for full
    vs slim. Also assert identical `searchRules` and `recentFeedback`
    results.
  - Pin the regexes against `SLIM_VERSION`: the test stores a hash of the
    `isNoise` / resolution-regex sources, and a change to either fails
    the test until `SLIM_VERSION` is bumped.
- `test/corpus.test.mjs`:
  - v1 and v2 corpora load identically;
  - a conflict-marker corpus gives a warning, not a crash (CLI test);
  - a `diff_hunk` containing a fake `ghp_` pattern no longer reaches the
    corpus.
- Manual check before release: re-run the scratch comparison
  (`slim.mjs` + CLI diff) on the five cached corpora using the real
  module. Expect byte-identical `candidates` and `run --dry-run`, and
  identical MCP output. Run `npm run eval:real` and expect no change.

## Docs & changelog

- `docs/cli.md#publish-corpus`: what is kept or dropped, `--full`, the
  format, and that the cache stays full.
- `README.md` team section: expected size (about 1 MB for a busy repo).
- `docs/how-it-works.md`: privacy (fewer handles committed).
- `TROUBLESHOOTING.md`: corpus merge conflict, so re-publish rather than
  hand-merge. Consider recommending `.gitattributes`
  `.reviewlore-corpus.json merge=ours`? (open question).
- CHANGELOG `[Unreleased]`:
  - Changed: smaller corpus.
  - Fixed: crash on a corrupt corpus.
  - Fixed: wrong `since` after an incremental fetch.

## Risks, compatibility & rollback

- **Heuristics are baked in.** A slim corpus cannot be re-analysed with
  looser filters: a lower minimum length, new resolution words, or a bot
  rule that turns out wrong. The `SLIM_VERSION` hash test forces a
  conscious bump. Re-publishing from the full home cache restores
  anything, and the maintainer and CI always have one.
- **Seeding a cache from a slim corpus** (plan 03 idea for ephemeral CI)
  makes that cache partly slim. This is harmless because slimming is
  idempotent and the cache is only used to publish and analyse.
- **Size claims are for these five repos.** A repo with heavy human
  discussion slims less: express only reaches 2.4×.
- **Rollback:** `publish-corpus --full`, or revert. Readers accept both
  versions, so no data migration is needed.

## Cross-cutting checks

- **Credentials:** no new credential handling. Less unscanned content is
  published (`diff_hunk`, `pr_title`), and `path` is now scanned.
- **Privacy:** pnpm goes from 687 → 112 commenter handles, and
  `pr_authors` is pruned. This is data minimisation in line with the
  repo's GDPR rule.
- **Determinism:** sorted, fixed key order, and a stable serializer.
  `fetched_at` is the only time-varying field.
- **Deps:** none. `zlib` would be built in, but it is not used.
- **stdout/stderr:** publish chrome stays on stderr.
- **Windows:** `\n` line endings in the file. Recommend a `.gitattributes`
  `-text` or `eol=lf` entry so CRLF checkouts don't create spurious diffs.
- **Plugin vs CLI:** both read through `loadCorpus`. The plugin gains
  faster `candidates` and MCP cold starts.

## Success metrics

- The pnpm corpus is ≤ 1.2 MB.
- Byte-identical `candidates` and `run --dry-run` output on the five
  reference repos.
- `eval:real` is unchanged.
- A monthly refresh diff is ≤ 1,000 lines for pnpm-size repos.
- The golden test is in CI.
- No `TypeError` on a corrupt corpus.

## Open questions for the owner

1. Ship `--full`, or drop the escape hatch to keep one format?
2. Should PR-author self-comments be dropped? They are exact for the
   toolkit, but the corpus stops being a general archive of the
   conversation.
3. Recommend a `.gitattributes` entry (`-diff`? `merge=ours`?) in the
   docs, or leave the repo's git config alone?
4. Should `publish-corpus` refuse a corpus over a size limit (e.g. 5 MB)
   and suggest a shorter `--months`?
