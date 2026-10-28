# 17 — Faster first fetch on busy repos

**Priority:** P1 · **Effort:** S–M (≈ 1–2 days) · **Depends on:** 03 (done)

_Status (October 2026): option 1 implemented. Wall-time gain still to be
measured live on pnpm._

## Problem

A first six-month fetch of pnpm (October 2026) took about 6 minutes and
~900 requests. Busy repos are the ones with enough history to produce
rules, so this is the first-run experience that matters most.

## Audit findings

Measured on the six-month pnpm fetch from 2026-10-27 (4,156 PRs updated
in the window), offline from the cached JSON:

| | count | per PR p50 / p99 / max | human share | body MB |
|---|---|---|---|---|
| issue comments (PR conversation) | 44,229 | 10 / 41 / 91 | 16 % | 238 |
| inline review comments | 30,975 | threads 3 / 38 / 77; comments per thread 2 / 4 / 8 | 39 % | 43 (+72 diff_hunk) |
| review submissions | 42,800 | 8 / 63 / 150 | 31 % | 27 |

- **Where the time goes.** Reviews already come over GraphQL (~85
  queries). The two REST comment listings are cursor-style pages read one
  after another: inline comments ≈ 310 pages, issue comments ≥ 400 pages
  (the listing also returns plain-issue comments, which are discarded).
  The live run spent ~1.3 s per page per stream, so the inline listing
  alone is ≈ 5 minutes — the critical path.
- **Bots can't be skipped server-side.** Neither REST nor GraphQL filters
  comments by author. Most of the ~380 MB of text is bot output
  (qodo, coderabbit, greptile, codecov, Copilot), downloaded either way.
- **Per-PR GraphQL for comments is costly.** Nesting
  `comments(first:100)` and `reviewThreads(first:50){comments}` under
  `pullRequests(first:50)` costs ≈ 27 points per query (the thread
  comments dominate: 50 × 50 / 100), ≈ 2,300 points for pnpm — half the
  user's 5,000 points/hour and over the Actions `GITHUB_TOKEN`'s 1,000.
  It also re-maps every review-comment field (`replyTo`, `line` /
  `originalLine`, `diffHunk`, URLs), which needs a new live parity check.
- **Time slices are valid REST pagination.** Both listings take `since`
  (on `updated_at`) and `sort=updated&direction=asc`, so a listing
  started at `since = t_k` can stop at the first item updated at or after
  `t_{k+1}`. Separate listings over disjoint slices return exactly the
  same comments as one long listing (the 400-page cut-off fix already
  relies on restarting from an update time).
- Activity is uneven over time (pnpm inline comments: 1.6 k in May,
  12.5 k in September), so equal-length slices are unbalanced.

## Options

1. **Parallel time slices for the REST comment listings (recommended).**
   Split the window into ~24 slices of equal length; 6 workers take the
   next unstarted slice (newest first, where activity is densest). Same
   endpoints, same records, same request count (+ ≤ 24 for slice ends).
   - Expected: comment listings ≈ 4–6× faster (wall time), so a pnpm
     first fetch in roughly 1.5–2 minutes — to be measured.
   - Within limits: 6 concurrent requests is well under GitHub's 100
     concurrent / 900 points-per-minute secondary limits.
   - Unchanged: request count, bandwidth, Actions budget, output.
2. **Per-PR GraphQL with bodies fetched only for human comments.**
   Metadata first (`id`, `author{__typename login}`, timestamps), then
   `nodes(ids:)` in batches of 100 for non-bot comments and thread
   members. Downloads ~5× less text and ~400 fewer REST requests, but
   ≈ 2,300 GraphQL points on pnpm, breaks first runs under the Actions
   token, changes `fetch` output (bot comments without bodies) and needs
   a new parity check. Revisit if bandwidth turns out to be the limit
   after option 1.

## Design (option 1)

- `lib/fetchers.mjs`: `listAscending` takes a list of slices
  `[{ from, to }]`; each slice is its own `paginate.iterator` listing that
  ends at the first item with `updated_at ≥ to` (items at or after `to`
  are left to the next slice) or when GitHub ends the listing — then the
  existing continue-from-`through` logic applies within the slice.
- The last slice is open-ended (`to = now`). A comment edited during the
  fetch can move into a slice already finished; the next incremental
  fetch covers it, since the cache's cutoff is the fetch's start time.
- Resume: partial state per slice (`{ from, to, through, done }`);
  `PARTIAL` version 2, version-1 partials are discarded.
- Progress: a stream's fraction is the share of its window covered by
  finished slices plus partial progress in running ones.
- Concurrency: one shared pool of 6 across both comment streams, so the
  two listings don't run 12 requests at once.

## Tests & verification

- Unit: slices partition the window exactly; items on a slice boundary
  belong to exactly one slice; a sliced fetch equals an unsliced one on
  the resume fixtures (including the 400-page cut-off simulation and
  time-budget resume); concurrency never exceeds the pool size.
- Live (owner, with a token): fetch pnpm six months into a fresh cache
  directory; compare comment ids with the 2026-10-27 run (expect equal up
  to comments added since) and record wall time and request count.

## Risks & rollback

- Secondary rate limit on very busy hosts: already retried
  (`lib/rate-limit.mjs`); pool size is one constant.
- `REVIEWLORE_FETCH_CONCURRENCY=1` restores sequential listing.
