# 14 — GitLab and Bitbucket support

**Priority:** P2 · **Effort:** L (≈ 8–10 days, estimate: provider interface 2, GitLab 3–4, Bitbucket Cloud 2–3, docs/skill 1) · **Depends on:** 02 (host-aware remote parsing, per-host storage, which this plan generalises); 03 (fetch concurrency/progress, reused); 11 (new token patterns `glpat-`, `ATATT`)

## Problem

Teams on GitLab or Bitbucket can't use the toolkit at all. Run inside a
GitLab checkout, it either rejects the remote (after plan 02) or, today,
misreads `group/sub/project` as `sub/project` and asks the GitHub API for
a repo that doesn't exist. Review culture on those hosts is just as rich
(merge request threads, inline diff notes, approvals), but nothing here can
read it.

**Why P2:** the project is still private and unreleased, there's no user
demand on record, and plan 02 (GitHub Enterprise) has to land first
because it introduces the host plumbing this plan builds on. Raise the
priority if early users ask, since the pipeline after fetch is already
provider-neutral.

_Status (October 2026): GitLab done (owner's choice: GitLab only).
`lib/providers/gitlab.mjs` (REST v4 over Node's fetch, discussions →
corpus shape), `lib/providers/index.mjs` (`openFetcher` for both
providers), remote parsing with nested groups and `--provider`, cache
keys with `+` for `/`. Not done: Bitbucket; the `glab api` transport (glab
wasn't available to test, and its pagination flags are unverified);
resumable GitLab fetches. No live GitLab test yet._

## Audit findings

- **Fetch is hard-wired to Octokit.** The three fetchers take an `octokit`
  instance (`lib/fetchers.mjs:16-117`). The orchestration is repeated at
  three call sites: `bin/commands/fetch.mjs:112-116`,
  `bin/reviewlore.mjs:357-360` (cache top-up) and `:406-409`.
  `lib/github-client.mjs` resolves `--token` → `GITHUB_TOKEN` →
  `gh auth token` and builds an `Octokit`.
- **Everything after fetch reads a provider-neutral shape.**
  `applySignals`, `extractCandidates`, clustering, renderers and the MCP
  tools use only `type, comment_id/review_id, pr_number, author,
  author_type, body, path, line, in_reply_to_id, created_at/submitted_at,
  state, html_url` and `meta.pr_authors`. That's the seam for adapters.
- **GitHub assumptions outside fetch:**
  - `lib/git-info.mjs:20` takes the last two path segments of any remote.
    `gitlab.com/group/sub/proj` becomes `sub/proj` (plan 02 changes this
    to a "not-github-shaped" error).
  - `isPlainIssueComment` (`lib/filters.mjs:37-39`) keys off `/issues/<n>`
    in `html_url`. It's needed only because GitHub's issue-comments
    endpoint mixes issues and PRs. GitLab/Bitbucket adapters fetch
    MR/PR-scoped data only, and their URLs (`/-/merge_requests/…`,
    `/pull-requests/…`) never match. No change needed, but the comment
    should say so.
  - Bot detection: `author_type === "Bot"` plus a GitHub-centric name
    regex (`lib/normalize.mjs:80-85`).
  - Cache key `<owner>__<repo>` (`lib/cache.mjs:35-37`). The MCP argument
    check `NAME_RE` rejects anything that isn't a "valid GitHub name"
    (`lib/mcp-tools.mjs:137-139`), which rules out GitLab subgroup paths.
  - User-facing text: `--owner`/`--repo`/`--token` help says GitHub
    (`bin/reviewlore.mjs:71-88`, `bin/commands/fetch.mjs:26-41`).
    `SKILL.md` step 1 mentions `GITHUB_TOKEN`/`gh auth login`.
    `lib/corpus.mjs:103` says "on GitHub".
- **GitLab API (verified in official docs):**
  - MRs: `GET /projects/:id/merge_requests` with `updated_after`,
    `order_by=updated_at`, `sort=desc`, `state=all`. `author.username`,
    and `author.bot` ("If true, the author is a bot")
    ([merge requests](https://docs.gitlab.com/api/merge_requests/)).
    `:id` accepts the URL-encoded project path.
  - Threads: `GET /projects/:id/merge_requests/:iid/discussions`. Each
    discussion has `id`, `individual_note`, `notes[]`. Each note has
    `id`, `type` (`DiffNote`/`DiscussionNote`/null), `body`, `author`
    (`username`, **no bot flag**), `created_at`, `system`, `resolvable`,
    `resolved`, `resolved_by`, and for diff notes `position`
    (`new_path`, `old_path`, `new_line`, `old_line`)
    ([discussions](https://docs.gitlab.com/api/discussions/)).
  - Approvals: `GET /projects/:id/merge_requests/:iid/approvals` →
    `approved_by[].user`, `approved_at`, available on all tiers
    ([approvals](https://docs.gitlab.com/api/merge_request_approvals/)).
    No review-body object and no documented "requested changes" state on
    that page. A per-reviewer state may exist elsewhere (unverified).
  - Pagination: `page`/`per_page` (max 100), `Link` and `x-next-page`
    headers. Keyset pagination for some resources. Auth header in examples
    is `PRIVATE-TOKEN` ([REST](https://docs.gitlab.com/api/rest/)).
  - `glab api` supports `--paginate`, `--hostname` (defaults to the
    authenticated host of the current git directory) and
    `--output ndjson` ([glab api](https://docs.gitlab.com/cli/api/)).
    glab reads `GITLAB_TOKEN` / `GITLAB_ACCESS_TOKEN` / `OAUTH_TOKEN` in
    preference to its stored credentials ([glab](https://docs.gitlab.com/cli/)).
    I found no documented `glab auth token` equivalent of `gh auth token`.
- **Bitbucket Cloud API** (official OpenAPI at
  `https://api.bitbucket.org/swagger.json`; HTML reference
  [here](https://developer.atlassian.com/cloud/bitbucket/rest/api-group-pullrequests/)):
  - `GET /repositories/{workspace}/{repo_slug}/pullrequests`. `state` is
    repeatable (`OPEN`, `MERGED`, `DECLINED`, `SUPERSEDED`). Filtering and
    sorting go through the generic `q`/`sort` mechanism; the exact
    `q=updated_on>…` syntax is unverified.
  - `GET …/pullrequests/{id}/comments`: "global and inline comments and
    replies", oldest first. Comment fields: `id`, `created_on`,
    `updated_on`, `content.raw`, `user`, `deleted`, `parent`, `inline`
    (`path`, `from`, `to`), `links.html`.
  - `GET …/pullrequests/activity` (repo-wide) and per-PR `/activity`
    include comments, approvals and change requests. This could replace
    the per-PR N+1 (unverified for completeness and ordering).
  - `participant`: `role` (`PARTICIPANT`/`REVIEWER`), `approved`, `state`
    (`approved`/`changes_requested`/null), `participated_on`.
  - Thread resolution: `POST/DELETE …/comments/{id}/resolve`
    (`comment_resolution`: `type`, `user`, `created_on`).
  - Pagination: `size`, `page`, `pagelen`, `next`, `previous` in the body.
  - Auth: app passwords are being retired in favour of scoped API tokens.
    New app passwords stopped on 9 Sep 2025, followed by a removal
    timeline in 2026 per Atlassian
    ([blog](https://www.atlassian.com/blog/bitbucket/bitbucket-cloud-transitions-to-api-tokens-enhancing-security-with-app-password-deprecation)).
    Exact read scopes for PRs are unverified.
  - Bitbucket Data Center/Server has a different API (`/rest/api/1.0`).
    Out of scope.
- **Semantic trap: "resolved" means something different.** On GitHub the
  toolkit infers resolution from reply text ("fixed", "done";
  `lib/signals.mjs:21-24`) and *drops* those threads. On GitLab, resolving
  every thread is routine, and often required before merge. Mapping
  native `resolved: true` to "drop" would discard most inline feedback.
  Native resolution must not feed the drop rule.

## Goals / Non-goals

**Goals:** fetch gitlab.com, self-managed GitLab and bitbucket.org review
history into the existing corpus shape, behind one provider interface,
with auth that never makes the toolkit (or Claude) read credential
stores. Everything downstream works unchanged.

**Non-goals:** Bitbucket Data Center, Azure DevOps, Gerrit (the interface
should make them possible later). GitLab GraphQL. Writing back to
any host.

## Options considered

1. **Separate CLIs per host.** Duplicated UX and docs. Rejected.
2. **Provider interface in `lib/providers/`, with adapters that emit the
   existing corpus schema.** One pipeline, and adapters are testable with
   recorded fixtures. **Chosen.**
3. **Shell out to `glab api` / Bitbucket CLIs for everything.** No token
   handling at all, but it requires those CLIs. Bitbucket has no official
   general-purpose CLI equivalent. Adopted only as the *GitLab* fallback
   transport (below).

## Design

### Provider interface (`lib/providers/`)

```js
// lib/providers/index.mjs
detectProvider({ remoteUrl, flagProvider, flagHost }) →
  { kind: "github" | "gitlab" | "bitbucket", host, repoPath }   // repoPath "group/sub/proj"
// each adapter: lib/providers/{github,gitlab,bitbucket}.mjs
export async function fetchReviewHistory(transport, { repoPath, since, onProgress }) →
  { issue_comments, review_comments, review_submissions, prAuthors }
export function describeAuth(host) → string   // help/error text, never a value
```

- `transport` is `{ getJson(path, query) , paginate(path, query) }`,
  built from Node's global `fetch` (Node ≥ 20.11, so no new deps), or
  from `glab api` for GitLab. Tests inject a fake transport. GitHub keeps
  Octokit inside its adapter.
- One `fetchCorpus(provider, …)` in `lib/fetch-corpus.mjs` replaces the
  three duplicated orchestration sites.
- `meta` gains `provider`, `host`, `repo_path`. `owner`/`repo` are kept
  (namespace / last segment) for compatibility.
- Storage: plan 02's `hosts/<host>/…` layout with `repoPath` encoded
  (`/` → `__`). github.com paths stay as they are.

### Mapping onto the corpus schema

| Corpus field | GitLab | Bitbucket Cloud |
|---|---|---|
| PR list / `pr_authors` | MRs `updated_after=since`, `author.username` | PRs with `updated_on` ≥ since (`q`/`sort`, or a client-side stop like Octokit's `done()`), `author.nickname` (fallback `account_id`) |
| `issue_comments` | notes in `individual_note: true` discussions, non-`system`, no `position` | comments without `inline` and without `parent` |
| `review_comments` | non-`system` notes in threads or with `position`; `path = position.new_path ?? old_path`, `line = new_line ?? old_line` | comments with `inline` (`path`, `line = to ?? from`), plus replies |
| `in_reply_to_id` | root note id of the discussion, for notes after the first | `parent.id` |
| `review_submissions` | approvals → `{ state: "APPROVED", body: "" }` (weight only, see below) | participants with `state` → `APPROVED` / `CHANGES_REQUESTED`, `body: ""` |
| `author_type` | `"Bot"` if the user is an MR author with `author.bot`, or the username matches `^(project|group)_\d+_bot` (naming unverified) | `"Bot"` if the account type marks an app (unverified), else name regex |
| `html_url` | `${mr.web_url}#note_${id}` (anchor convention, verify) | `links.html.href` |
| `created_at` | `created_at` | `created_on` |
| dropped | `system: true` notes | `deleted: true` comments |
| `diff_hunk` | null (not exposed directly; plan 05 drops it anyway) | null |
| native resolution | stored as `resolved` for information, **not** used to drop | same, from `resolution` (field presence unverified) |

Review state weighting: GitLab and Bitbucket have no review body, so
state lives on "reviewer × PR". Adapters set `state` on each comment from
that reviewer's state on that PR (`CHANGES_REQUESTED` for Bitbucket
`changes_requested`; nothing for GitLab unless a reviewer-state endpoint
is confirmed). `applySignals` already weights by `state` when present.
Plan 07 generalises inheritance for GitHub via `review_id`.

### Auth (no credential crawling)

- **GitLab:** `--token`, then `GITLAB_TOKEN`, then `GITLAB_ACCESS_TOKEN`,
  sent as `PRIVATE-TOKEN`. Scope needed: `read_api`. If none is set and
  `glab` is installed, use **`glab api` as the transport**
  (`glab api --hostname <host> --paginate --output ndjson <path>`), so
  glab authenticates and the toolkit never sees a token. The toolkit
  never reads `~/.config/glab-cli/config.yml`.
- **Bitbucket:** `--token` (+ `--user <email>`), or `BITBUCKET_EMAIL` +
  `BITBUCKET_API_TOKEN` (Basic auth with a scoped API token), or
  `BITBUCKET_ACCESS_TOKEN` (Bearer, repository/workspace access token).
  App passwords are not supported (deprecated).
- Errors name the host and env var, never the value
  (`.claude/rules/no-token-logging.md`). Plan 11 adds `glpat-` and
  `ATATT` to the secret patterns.

### Detection and flags

- `parseRemote` (plan 02's `lib/github-host.mjs`, renamed
  `lib/remote.mjs`) accepts multi-segment paths and returns a `kind`:
  `github.com`/GHE rules from 02, `gitlab.com` → gitlab,
  `bitbucket.org` → bitbucket. Unknown hosts need `--provider
  gitlab|bitbucket|github` or config `provider:`.
- New flags: `--provider`, `--repo-path <group/sub/proj>` (alternative to
  `--owner/--repo`). `--host` comes from plan 02.
- MCP tools take an optional `repo_path` and validate it as
  `^[A-Za-z0-9_.-]+(/[A-Za-z0-9_.-]+){1,19}$` (no `..`).

## Implementation steps

1. `lib/remote.mjs` (generalise plan 02's module) + tests for GitLab
   subgroup, self-managed and Bitbucket remotes.
2. `lib/providers/index.mjs`, `lib/http.mjs` (fetch transport: Link/`next`
   pagination, 429 `Retry-After`, no token in errors), and
   `lib/fetch-corpus.mjs`. Move the Octokit fetchers into
   `lib/providers/github.mjs` (re-export from `lib/fetchers.mjs` for
   compatibility).
3. `lib/providers/gitlab.mjs` + `lib/providers/glab-transport.mjs`.
4. `lib/providers/bitbucket.mjs`.
5. Wire `bin/commands/fetch.mjs` and `bin/reviewlore.mjs` to
   `fetchCorpus`. Add the flags and provider-neutral help text.
6. `lib/normalize.mjs` (GitLab bot name pattern), `lib/mcp-tools.mjs`
   (`repo_path`), `lib/cache.mjs`/`lib/corpus.mjs` (host/path keys).
7. `skills/learn-from-reviews/SKILL.md`: provider-neutral wording, the
   auth options per host, "never read credential files".
8. `scripts/check-pack.sh` REQUIRED for new files. Docs. CHANGELOG.

## Tests & verification

- Hermetic adapter tests with synthetic recorded responses
  (`test/fixtures/gitlab/*.json`, `test/fixtures/bitbucket/*.json`) and a
  fake transport: mapping per the table, system notes and deleted
  comments dropped, thread `in_reply_to_id`, `since` cut-off, pagination
  across 3 pages, bot detection, state propagation, `html_url` shape.
- `test/http.test.mjs`: Link-header and body-`next` pagination, 429 retry,
  error text contains the host but not the token (a fake `glpat-xxx`).
- `test/remote.test.mjs`: GitLab subgroups, ssh/https, self-managed with
  `--provider`, Bitbucket.
- Downstream: run `extractCandidates` on a mapped GitLab fixture and
  assert the same clusters as an equivalent GitHub-shaped fixture.
- Manual: one public gitlab.com project and one public bitbucket.org
  repo, 3 months, owner's tokens. Record request counts and duration.
- `eval:real` unchanged. Add GitLab comments to plan 13's fresh held-out
  pool only if a GitLab repo is chosen.

## Docs & changelog

README ("GitHub, GitLab and Bitbucket Cloud"), `docs/cli.md` (providers,
auth per host, flags), `docs/how-it-works.md` (fetch section, resolution
semantics), `SKILL.md`, `CONTRIBUTING.md` (adding a provider),
CHANGELOG `[Unreleased]`.

## Risks, compatibility & rollback

- **API drift and unverified details** (Bitbucket `q` syntax and
  `resolution`, GitLab note anchors and reviewer state, bot naming). Each
  needs a verification task before coding the mapping row. Fall back to
  client-side filtering where a filter is uncertain.
- **Request volume:** GitLab needs one discussions call per MR (+1 for
  approvals). Comparable to GitHub today; reuse plan 03's concurrency
  limits.
- **Identity:** Bitbucket has no stable public username. Using `nickname`
  in rule citations may be less recognisable. Never use `display_name`
  (real names; plan 11).
- GitHub behaviour must stay byte-identical: the existing tests plus a
  GitHub fixture through the new `fetchCorpus` guard it. Rollback means
  reverting the provider dispatch, since GitHub stays the default.

## Cross-cutting checks

- **Credentials:** env/flag only. `glab api` as transport means no token
  is handled. Never read glab/gh/Atlassian config files. Tokens are never
  logged, and errors say "set GITLAB_TOKEN" without a value.
- **Privacy:** same data classes as GitHub. The plan 11 data statement
  lists the hosts contacted.
- **Determinism:** adapters sort by id/created time before returning.
- **Deps:** none (global `fetch`). Octokit stays GitHub-only.
- **stdout/stderr:** progress to stderr via the existing logger.
- **Windows:** `glab` invoked via `spawnSync` with an argument array, no
  shell.
- **Plugin vs CLI:** the plugin gets support through the same CLI. The
  MCP server gains `repo_path`.

## Success metrics

- One public GitLab and one public Bitbucket repo produce non-empty
  `candidates` with correct URLs (spot-check 20 citations, all resolve to
  the quoted comment).
- No GitHub regression: the full test suite and `eval:real` are
  unchanged.
- Zero token values in any output (secret-pattern grep of test logs).

## Open questions for the owner

1. Is there real demand (a user or employer on GitLab/Bitbucket) to
   justify ~2 weeks now, or keep this P2 until after the public release?
2. GitLab: fetch-based transport only, or also `glab api` (an extra
   process per page, but no token handling)?
3. Bitbucket Data Center: in or out for a later phase?
