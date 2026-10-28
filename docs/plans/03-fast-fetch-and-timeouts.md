# 03 — Fast, resumable first fetch that fits inside Claude Code

**Priority:** P0 · **Effort:** M (≈ 4–5 days, estimate) · **Depends on:** none (02 changes the client constructor; 05 shares the `meta.since` fix)

## Problem

The first run against a busy repo makes one GitHub request per pull
request, about 1,000 for pnpm. That takes minutes. In Claude Code the
skill's single command passes the Bash tool's 2-minute default, so it is
moved to the background or (with background tasks off) stopped. Nothing is
saved until every request has finished, so a stop throws all the work away
and the next attempt starts from zero. The shipped GitHub Action re-fetches
everything weekly and can exceed the Actions token's hourly limit on such
repos.

## Audit findings

- **Per-PR review loop.** `lib/fetchers.mjs:91-115` calls
  `pulls.listReviews` once per in-range PR, sequentially, after listing
  PRs (`:64-79`). Requests per repo, computed from the cached corpora as
  PR count + list pages:

  | repo | REST requests today | with GraphQL reviews (Design) |
  |---|---|---|
  | pnpm | ≈ 1,040 | ≈ 81 |
  | vitest | ≈ 913 | ≈ 63 |
  | express | ≈ 693 | ≈ 26 |

  Wall-clock time was not measured (no network in this audit). At an
  assumed 0.3–0.5 s per request, pnpm takes about 5–9 minutes (estimate).
- **All-or-nothing.** The three fetchers run under one `Promise.all`, and
  the cache is written only after all of them succeed
  (`bin/commands/fetch.mjs:111-136`; `bin/reviewlore.mjs:405-423`
  and `:357-368`). A kill or a 403 halfway loses everything.
- **No rate-limit handling.** `@octokit/rest` 21.1.1 depends only on
  core, paginate-rest, request-log and rest-endpoint-methods
  (`node_modules/@octokit/rest/package.json`). There is no retry or
  throttling plugin, so any 403 or 429 fails the whole run with
  "Rate limited or insufficient scope".
- **GraphQL needs no new dependency.** `@octokit/core` sets
  `this.graphql = withCustomRequest(this.request)`
  (`node_modules/@octokit/core/dist-src/index.js:92`). For a GHES
  `…/api/v3` baseUrl it rewrites the URL to `…/api/graphql`
  (`@octokit/graphql/dist-src/graphql.js:14,46-47`). There is no GraphQL
  paginator (`plugin-paginate-graphql` is not installed), and
  `.claude/rules/octokit-pagination.md` only covers REST.
- **Reviews per PR** (pnpm): 733 of 969 PRs have reviews in the window.
  The maximum is 57, p99 is 33, and 2 PRs have more than 50.
  `reviews(first: 50)` covers all but 2 PRs.
- **GitHub limits** (docs.github.com, fetched 2026-10-27):
  - REST: 5,000 requests per hour per user. `GITHUB_TOKEN` in Actions gets
    **1,000 per hour per repository** (15,000 on Enterprise Cloud).
  - Secondary limits: 100 concurrent requests; **900 points per minute
    for REST** and 2,000 for GraphQL. On a secondary limit, honour
    `retry-after`, else wait at least 1 minute and back off exponentially.
  - GraphQL cost is (sum of requests per connection at max `first`) ÷ 100,
    rounded, minimum 1.
  - Requests taking more than 10 s return 502/504 and cost extra points.

  Sources: [REST rate limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api),
  [GraphQL limits](https://docs.github.com/en/graphql/overview/rate-limits-and-query-limits-for-the-graphql-api).
- **The Action template exceeds the Actions limit.**
  `examples/github-action/regenerate-rules.yml` runs `fetch --cache` with
  `GITHUB_TOKEN` on a fresh runner (empty `~/.reviewlore`), so
  every weekly run is a full fetch. That is about 1,040 requests for pnpm,
  above the 1,000/h `GITHUB_TOKEN` limit.
- **GraphQL fields verified** ([pulls reference](https://docs.github.com/en/graphql/reference/pulls)):
  - `PullRequest.reviews(first, after, states)`, `author`, `number`,
    `title` and `updatedAt` exist.
  - `PullRequestReview` has `fullDatabaseId`, `author`, `state`, `body`,
    `submittedAt` and `url`.
  - `databaseId` is deprecated in favour of `fullDatabaseId`.
  - `Repository.pullRequests(orderBy: UPDATED_AT)` was not re-checked in
    this audit.
- **REST list endpoints support ascending `updated` order.** Both
  `issues.listCommentsForRepo` and `pulls.listReviewCommentsForRepo`
  accept `sort=updated&direction=asc` and filter `since` by last update.
  This makes a "last `updated_at` seen" checkpoint valid
  ([issue comments](https://docs.github.com/en/rest/issues/comments#list-issue-comments-for-a-repository),
  [review comments](https://docs.github.com/en/rest/pulls/comments#list-review-comments-in-a-repository)).
- **Claude Code Bash tool** ([tools reference](https://code.claude.com/docs/en/tools-reference),
  [env vars](https://code.claude.com/docs/en/env-vars), fetched 2026-10-27):
  - The default timeout is 120,000 ms and Claude may request up to
    600,000 ms (`BASH_DEFAULT_TIMEOUT_MS` / `BASH_MAX_TIMEOUT_MS`).
  - A foreground command that reaches its timeout is **moved to the
    background, not killed**. The result says "Command did not complete
    within its 120s timeout and was moved to the background", with an
    output-file path.
  - It *is* stopped instead when `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1`
    is set or in bare mode.
  - In unattended sessions (`-p`, SDK, CI, cloud), background commands get
    30 minutes (10 minutes for text-prompt `-p`).

  The brief's "killed after 2 minutes" is therefore true only in those
  configurations (and possibly older versions; the version that
  introduced auto-backgrounding was not verified). The real gaps:
  - `SKILL.md:28-30` says nothing about waiting for a backgrounded
    command;
  - its `… && echo "$out"` prints the path into a task output file, not
    the transcript;
  - a stop loses all progress.
- **Skill and stage gaps.**
  - `fetch` requires `--owner/--repo`; it has no git auto-detection
    (`bin/commands/fetch.mjs:70-80`).
  - `fetch` always writes `pr-comments-<repo>-<ts>.json` into `--out`
    (default `.`) (`:138-143`). Run from a repo root, it drops a
    multi-MB file into the user's working tree.
- **Incremental bugs** (reproduced in scratch with `mergeIntoCache`):
  - Merged `meta.since` becomes the last incremental cutoff
    (`lib/cache.mjs:68-73`).
  - `--months 12` against a 6-month cache never backfills: `inc > since`
    picks the incremental cutoff (`bin/reviewlore.mjs:396-402`),
    and `filterSince` then silently returns only the cached 6 months.

## Goals / Non-goals

Goals:
- A first fetch of a pnpm-size repo in under 100 requests and under about
  1 minute.
- Progress with an ETA.
- Survive rate limits.
- Resume after any interruption.
- A skill flow that completes regardless of Bash timeout settings.
- An Action that fits the `GITHUB_TOKEN` budget.

Non-goals:
- Moving issue and review-comment listing to GraphQL (already efficient
  in REST).
- Background daemons.
- New runtime dependencies.

## Options considered

1. **Bounded-concurrency REST** (hand-rolled limiter, 4–6 in flight).
   - Small change, same data shape.
   - Still about 1,040 requests: it breaks the Actions 1,000/h budget and
     costs about 20 % of a user's hourly 5,000.
   - The 900 points/min secondary limit caps throughput at 15 requests/s,
     so pnpm takes at least 70 s anyway.
   - Raises secondary-limit risk.
2. **GraphQL for the PR list plus reviews** (one query per 50 PRs, with
   nested `reviews(first: 50)`).
   - About 20 queries of about 1 point each for pnpm; 92 % fewer requests
     overall.
   - Cost: a hand-written cursor loop and a GraphQL → REST shape mapper.
   - Needs a rule amendment (GraphQL is not covered by `octokit.paginate`).
   - **Chosen.**
3. **GraphQL for everything** (review threads and PR comments too).
   - Would also skip plain-issue comments server-side.
   - But it needs doubly nested pagination (threads → comments), carries
     a higher risk of 10 s timeouts on large pages, and makes a much
     bigger change to `in_reply_to_id` and thread semantics.
   - Deferred; revisit if issue-comment pages dominate.

## Design

**1. GraphQL review fetcher** (`lib/fetchers.mjs`, replaces the loop):

```graphql
query($owner:String!,$repo:String!,$after:String){
  repository(owner:$owner,name:$repo){
    pullRequests(first:50,after:$after,orderBy:{field:UPDATED_AT,direction:DESC}){
      pageInfo{hasNextPage endCursor}
      nodes{ number title updatedAt author{login __typename}
        reviews(first:50){ pageInfo{hasNextPage endCursor}
          nodes{ fullDatabaseId url state body submittedAt author{login __typename} } } } } }
  rateLimit{cost remaining resetAt}
}
```

- The loop stops when the last node's `updatedAt` < `since` (same early
  exit as today).
- If a PR has `reviews.pageInfo.hasNextPage`, a follow-up query pages
  that PR's reviews. This happens rarely: 2 PRs on pnpm.
- Mapping to today's record shape:
  - `review_id` = `Number(fullDatabaseId)` (the IDs are about 4e9, safe
    below 2^53);
  - `html_url` = `url`;
  - `author` = `login ?? "unknown"`;
  - `author_type` = `__typename === "Bot" ? "Bot" : "User"`;
  - `state` and `body` are passed through;
  - `submitted_at` = `submittedAt`;
  - `pr_title` stays (unless 05 drops it from the corpus);
  - `prAuthors` is built as today.
- Fallback: if the query fails with a GraphQL schema error (old GHES
  without `fullDatabaseId`, see 02), retry once with `databaseId`. If
  GraphQL is unavailable (403 for an app without GraphQL access), fall
  back to the old REST loop with concurrency 4 and log the reason.
- The page size of 50 keeps each response small and away from the 10 s
  timeout. The cost per page is (1 + 50 × 1) ÷ 100, which rounds to 1.

**2. Rate-limit handling** (`lib/rate-limit.mjs`, pure apart from an
injected `sleep`). Wrap requests through `octokit.hook.wrap("request", …)`.
This is core's `before-after-hook`. `this.request` is built with
`hook: hook.bind(null, "request")`, and `this.graphql` wraps
`this.request` (`@octokit/core/dist-src/index.js:68-94`), so GraphQL
calls pass through the same hook:

- 403 or 429 with `retry-after`: wait that long.
- 403 or 429 with `x-ratelimit-remaining: 0`: wait until
  `x-ratelimit-reset` if that is ≤ `--max-wait` (default 60 s). Otherwise
  save the checkpoint and fail with "Rate limit resets at 14:05 UTC —
  re-run then; progress is saved."
- A secondary limit without headers: wait 60 s, then double the wait, up
  to 3 attempts.
- 502 or 504: retry twice.
- Never log headers or the request's `authorization`.

**3. Resumable fetch.**
- Each stream checkpoints into
  `<cacheDir>/<owner>__<repo>.partial.json`, written atomically and under
  the existing lock:
  - issue comments and review comments are fetched
    `sort=updated, direction=asc`, and the checkpoint stores
    `through_updated_at` plus the items so far;
  - the PR/review stream stores its GraphQL `endCursor` and items.
- The checkpoint is written at most every 5 s.
- On start, a partial file with the same `since` resumes. On success the
  partial is merged into the cache and deleted.
- `mergeIntoCache` keeps the *earliest* `meta.since`. It records
  `meta.coverage_from` and `meta.coverage_to` (= `last_fetched_at`).
- Incremental mode is used only when `coverage_from` ≤ the requested
  `since`. Otherwise the gap `[requested since, coverage_from)` is
  fetched as well (backfill).

**4. Progress and ETA** (stderr only; TTY overwrites, non-TTY prints one
line per 5 s):

```
reviews   ▸ 350 PRs, back to 2026-02-03 (61% of window) · 8 req · ~12 s left
comments  ▸ 1,900 inline comments (74%) · 19 req
```

The window percentage is `(now − oldest updated_at seen) / (now − since)`
for descending streams, mirrored for ascending ones. The ETA comes from
elapsed time ÷ progress. At the end it prints
"Done in 41 s · 81 requests · GraphQL points used 22 · REST remaining 4,912".

**5. Time budget for agents.** `fetch --time-budget <seconds>` stops
cleanly after the budget:
- it finishes the in-flight page, writes the checkpoint, and exits with
  code **75** (EX_TEMPFAIL);
- it prints "Partial: 61% of window fetched; re-run the same command to
  continue." on stderr.

This works whatever the Bash timeout, background setting or Claude Code
version.

**6. `fetch` stage fixes.**
- Auto-detect owner/repo (and host, see 02) from git, as `run` does.
- Add `--no-output`, which writes only the cache (the skill uses it).

**7. Skill flow** (`skills/learn-from-reviews/SKILL.md` step 1):
- If there is no committed corpus and no cache, first run:

  ```bash
  node "${CLAUDE_PLUGIN_ROOT}/bin/reviewlore.mjs" fetch --cache --no-output --time-budget 90
  ```

- Exit 75 means: re-run the same command (each run resumes) and tell the
  user the progress line. Repeat until exit 0, at most 15 runs, then
  stop and report.
- Then run `candidates` as today. It finds a fresh cache and makes a few
  incremental requests.
- Write `candidates` output to a fixed path inside `$TMPDIR` via
  `mktemp`, and print the path *before* the long command runs, so a
  backgrounded run still leaves a known file. Add: "If Claude Code moves
  a command to the background, wait for its completion notice and read
  its output file; never start a second fetch for the same repo."

**8. Action.**
- Cache `~/.reviewlore` with `actions/cache` keyed by repo, so
  weekly runs are incremental: about 10–30 requests.
- Seed it from the committed corpus when the cache is missing (requires
  05's v2 corpus to carry `coverage_from` and `last_fetched_at`).

## Implementation steps

1. `lib/rate-limit.mjs` (new) plus wiring in `lib/github-client.mjs`.
2. `lib/fetchers.mjs`:
   - `fetchReviewSubmissionsGraphQL`, keeping the REST loop as
     `fetchReviewSubmissionsRest` (fallback, concurrency 4);
   - an `onPage` callback for checkpoints;
   - `sort/direction` on the two list streams;
   - a progress reporter object (stderr writer injected from `bin/`, per
     the CLAUDE.md "lib doesn't print" rule; the existing `log` moves out).
3. `lib/cache.mjs`: partial checkpoint read/write/delete, `coverage_from`
   and `coverage_to`, and no overwrite of `since`.
4. Shared `fetchAll(octokit, {owner, repo, since, budgetMs, onProgress})`
   in `lib/fetchers.mjs`, used by `bin/commands/fetch.mjs` and by both
   fetch paths in `bin/reviewlore.mjs`. This removes three
   copies of the `Promise.all` block.
5. `bin/commands/fetch.mjs`: git auto-detect, `--no-output`,
   `--time-budget`, `--max-wait`, exit code 75, and help text.
6. `skills/learn-from-reviews/SKILL.md`: step 1 as in Design §7.
7. `examples/github-action/regenerate-rules.yml` and its README:
   `actions/cache` step.
8. `.claude/rules/octokit-pagination.md`: add a "GraphQL" section
   (cursor loop with `pageInfo`, page size ≤ 50 with nested connections,
   always select `rateLimit{cost}`, early exit on `updatedAt`).
9. `scripts/check-pack.sh`: add new lib files.

## Tests & verification

All tests are hermetic: a fake octokit with `graphql`, `paginate`,
`paginate.iterator` and `hook`, as in `test/fetchers.test.mjs:15-46`.

- GraphQL fetcher:
  - cursor loop;
  - early stop on `updatedAt`;
  - nested review overflow triggers a follow-up query;
  - `fullDatabaseId` → number, `Bot` → `author_type`, null author;
  - a schema-error fallback to `databaseId`;
  - a 403 fallback to the REST loop.
- **Shape parity:** a paired REST and GraphQL fixture for the same PRs
  produces deep-equal `review_submissions` and `prAuthors`.
- Rate limit, with an injected clock and sleep:
  - `retry-after` is honoured;
  - a reset beyond `--max-wait` saves the checkpoint and throws a
    friendly error;
  - backoff stops after 3 attempts;
  - error text contains no header or token values.
- Resume: a fake that throws after page 2 → re-run → the merged result
  equals an uninterrupted run. A partial file whose `since` differs is
  discarded.
- Coverage: a `--months 12` request against a 6-month cache fetches the
  gap. `meta.since` is preserved across merges.
- CLI:
  - `fetch --time-budget 0` exits 75 and writes the partial;
  - `--help` and `--version` still need no auth (smoke test);
  - `--no-output` writes no file into cwd.
- Eval: extraction is unchanged; `npm run eval:real` must stay at
  69.6 % / 64.0 %.
- Manual check (owner, with a token):
  - fetch pnpm with `--months 6` both ways (REST vs GraphQL) into
    separate cache dirs; diff the sorted records (expect identical
    review sets);
  - record the request count and wall time;
  - run the skill in Claude Code with `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1`
    and with defaults.

## Docs & changelog

- `docs/cli.md` (fetch: new flags, exit code 75, auto-detect).
- `docs/how-it-works.md` (request budget).
- `TROUBLESHOOTING.md` (rate limits, resume, Actions limit).
- `examples/github-action/README.md`.
- CHANGELOG:
  - Changed: GraphQL reviews, about 12× fewer requests.
  - Added: resume, `--time-budget`, progress.
  - Fixed: `since` overwrite and the missing backfill.

## Risks, compatibility & rollback

- **GraphQL differences.** Review `url` format and `state` values should
  match REST but are unverified on live data; the manual parity diff
  gates release. Fine-grained PATs and the Actions `GITHUB_TOKEN` work
  with GraphQL (assumed; verify).
- **Ascending sort changes page order only.** Records are deduped by id,
  so results are unchanged.
- **Partial files hold comment bodies** in the cache directory, the same
  sensitivity as the cache itself. Delete them on success.
- **Rollback:** `REVIEWLORE_FETCH=rest` env switch for one release, then
  remove it.

## Cross-cutting checks

- **Credentials:** tokens never logged, including rate-limit messages and
  partial files. Each token is used only with its own host (02).
- **Privacy:** no new data is collected.
- **Determinism:** fetch order does not affect output (dedup and sort in
  05).
- **Deps:** none. GraphQL comes from `@octokit/core`; the hook comes from
  core.
- **stdout/stderr:** progress goes to stderr; `fetch` stdout stays empty.
- **Windows:** the `.partial.json` rename is atomic on NTFS for the same
  volume. Exit code 75 is fine on Windows.
- **Plugin vs CLI:** both go through `fetchAll`. The skill gets
  `--time-budget`.

## Success metrics

- pnpm 6-month first fetch: ≤ 100 requests (from ≈ 1,040) and ≤ 60 s
  wall time (to be measured).
- A weekly Action run on pnpm uses ≤ 100 `GITHUB_TOKEN` requests.
- The skill completes on pnpm with background tasks disabled.
- A fetch killed at any point resumes without refetching completed pages.

## Open questions for the owner

1. Is exit code 75 for "partial" acceptable, or should it exit 0 with a
   JSON status on stderr?
2. Should `candidates` itself accept `--time-budget`, removing the
   separate fetch step from the skill?
3. Should the REST fallback be kept permanently, given that GHES GraphQL
   coverage varies?
4. Should the Action seed its cache from the committed corpus (couples 03
   to 05's format)?
