# Octokit pagination — always use `octokit.paginate`

When fetching list endpoints from the GitHub REST API, always use
`octokit.paginate(method, params)` (or `octokit.paginate.iterator(...)`),
never manual `?page=N` loops.

**Why:** Manual pagination loops repeatedly miss the last page edge case,
forget `per_page=100` (causing 10× more requests), and don't respect
secondary rate limits. Octokit's paginator handles all of this and supports
an early-exit callback for descending date scans.

**How to apply:** For any new fetcher in `lib/fetchers.mjs`:
1. Use `octokit.paginate(octokit.rest.<namespace>.<method>, { per_page: 100, ... })`.
2. For endpoints that accept `since`, pass `since.toISOString()` and still
   re-filter the result by `created_at` (the API filters by `updated_at`,
   which over-includes).
3. For descending scans (e.g., PRs sorted by `updated`), pass a
   `(response, done) => { if (last older than since) done(); ... }` callback
   to stop early instead of paging through years of history.
4. Never set `per_page` below 100 — every request costs the same rate-limit
   budget regardless of page size.

## GraphQL

Octokit has no GraphQL paginator here (`plugin-paginate-graphql` isn't a
dependency), so GraphQL connections use a hand-written cursor loop. The
PR-review fetcher in `lib/fetchers.mjs` is the reference:

1. Loop on `pageInfo { hasNextPage endCursor }`, passing `after`.
2. A cursor loop is sequential. When each item needs a heavy nested
   connection (reviews of a PR), list the items lightly first, then fetch
   the heavy part in batches of aliased lookups
   (`p0: pullRequest(number: 1) { … } p1: …`, 25 per query), several
   batches at once. Keep nested `first` at 50: larger pages risk GitHub's
   10-second timeout.
3. Select `rateLimit { cost remaining resetAt }` on the outer query.
4. For descending `UPDATED_AT` scans, stop once a node is older than
   `since` — don't page through years of history.
5. When a nested connection has `hasNextPage`, page it with a separate
   query for that node; don't raise `first`.
6. Map results to the same record shape as the REST fetcher (bot logins
   get REST's `[bot]` suffix) and keep a parity test.

Retries and rate limits for both APIs are handled once, in
`lib/rate-limit.mjs`, through Octokit's `request` hook — don't add
per-call retry loops.
