# 02 — GitHub Enterprise Server and GHE.com

**Priority:** P1 · **Effort:** M (≈ 3 days, estimate; plus a manual check on a real GHES/GHE.com instance) · **Depends on:** none (03's GraphQL fetcher must take the host's base URL; 06's MCP tools gain a `host` argument)

_Status (October 2026): implemented as designed; hermetic tests only.
Not verified on a live GitHub Enterprise Server or GHE.com instance
(owner or a volunteer with access): rule URLs, GraphQL on the oldest
supported GHES, and whether `fullDatabaseId` exists there (the fetcher
falls back to `databaseId`)._

## Problem

Teams on GitHub Enterprise Server (`github.acme.corp`) or GHE.com
(`acme.ghe.com`) cannot use the toolkit. Inside their checkout,
`run` / `candidates` / the plugin skill detect `acme/app` from the remote,
drop the host, and query `api.github.com` with the user's github.com
token. The usual outcome is "Repo not found", which gives no hint that
the host is the problem. If a public repo with the same name exists, the
toolkit silently learns rules from the wrong repository. These are often
exactly the companies with the most internal review history.

## Audit findings

- **No base-URL configuration anywhere.** `lib/github-client.mjs:40`
  builds `new Octokit({ auth, userAgent })`, which defaults to
  `https://api.github.com` (`@octokit/endpoint/dist-src/defaults.js:6`).
  `grep -rn "baseUrl\|GITHUB_API_URL\|GH_HOST\|GH_ENTERPRISE"` over `lib/`
  and `bin/` finds nothing.
- **The git remote parser discards the host instead of rejecting it.**
  `lib/git-info.mjs:20` uses `/[:/]([^/:]+)\/([^/]+?)(?:\.git)?$/`, so any
  host matches. Tested offline:

  | remote | parsed today | correct |
  |---|---|---|
  | `https://ghe.corp.example/acme/app.git` | `acme/app` (host lost) | host + `acme/app` |
  | `ssh://git@ghe.corp.example:2222/acme/app.git` | `acme/app` | host + `acme/app` |
  | `https://acme.ghe.com/team/app` | `team/app` | GHE.com host |
  | `https://gitlab.com/group/sub/proj.git` | `sub/proj` (wrong) | reject |
  | `git@github.com-work:o/r.git` (SSH alias) | `o/r` | github.com |
  | `https://github.com/o/r/` (trailing slash) | `null` | `o/r` |

  The comment at `git-info.mjs:18-19` claims github.com forms only. The
  tests (`test/git-info.test.mjs`) cover only github.com.
- **The token is not tied to a host.**
  - `resolveToken` (`lib/github-client.mjs:12-18`) uses `--token`, then
    `GITHUB_TOKEN`, then `gh auth token` with no `--hostname`, which
    returns the token for gh's *default* host
    ([gh auth token](https://cli.github.com/manual/gh_auth_token)).
  - Pointing the client at a GHES host with this logic would send a
    github.com credential to a third-party server. Pointing it at
    github.com with a GHES token from `GITHUB_TOKEN` would leak the
    corporate token to github.com.
  - gh's own convention
    ([gh environment](https://cli.github.com/manual/gh_help_environment)):
    `GH_TOKEN` / `GITHUB_TOKEN` apply to github.com and `*.ghe.com`;
    `GH_ENTERPRISE_TOKEN` / `GITHUB_ENTERPRISE_TOKEN` apply to GHES;
    `GH_HOST` sets the host when a command has no other context.
- **API endpoints.**
  - GHES REST: `https://HOSTNAME/api/v3`
    ([GHES REST quickstart](https://docs.github.com/en/enterprise-server@latest/rest/quickstart)).
  - GHE.com: `https://api.SUBDOMAIN.ghe.com`
    ([about GHE.com](https://docs.github.com/en/enterprise-cloud@latest/admin/data-residency/about-github-enterprise-cloud-with-data-residency)).
  - GHE.com SSH remotes have the form `SUBDOMAIN@SUBDOMAIN.ghe.com:OWNER/REPO.git`
    ([network details](https://docs.github.com/en/enterprise-cloud@latest/admin/data-residency/network-details-for-ghecom)).
  - Octokit's GraphQL client maps a `…/api/v3` baseUrl to `…/api/graphql`
    (`node_modules/@octokit/graphql/dist-src/graphql.js:14,46-47`), so
    03's GraphQL fetcher works on GHES with no extra code. For GHE.com,
    `baseUrl + /graphql` is the default.
- **The cache and corpus are keyed by owner/repo only.**
  - `cachePath` is `<owner>__<repo>.json` (`lib/cache.mjs:35-37`).
  - Corpus meta has only `owner` and `repo` (`lib/output.mjs:19-34`).
  - The corpus/target match compares `owner/repo`
    (`bin/reviewlore.mjs:324-328`).
  - MCP `loadData` / `listRepos` (`lib/mcp-tools.mjs:13-41`) parse file
    names on the first `__`.

  As a result, `github.com/acme/app` and `ghe.acme/acme/app` would share
  one cache file.
- **URL handling is already host-agnostic.**
  - `isPlainIssueComment` (`lib/filters.mjs:37-39`) matches `/issues/<n>`
    in the path only.
  - `pr_number` comes from the last segment of `issue_url` /
    `pull_request_url` (`lib/fetchers.mjs:27,48`).
  - Rule files quote `html_url` as returned, so links point at the
    enterprise host automatically.
  - Not verified on a live instance: that GHES `html_url`s use the same
    `/OWNER/REPO/pull/N#…` path shape, and that `pulls.listReviewCommentsForRepo`
    exists on the oldest GHES version we would support.
- **Error text assumes github.com.**
  - `fetch.mjs:157-159` and `reviewlore.mjs:427-429` map 401 /
    403 / 404 without naming the host.
  - `SKILL.md:50-53` says `gh auth login` with no `--hostname`.
- Callers of `detectRepoFromGit`: `bin/reviewlore.mjs:268,598`
  and `lib/init-wizard.mjs:128`. `fetch` has no auto-detection (see 03).

## Goals / Non-goals

Goals:
- Fetch from GHES and GHE.com with the right token for the right host.
- Detect the host from the git remote.
- Keep caches and corpora apart per host.
- Fail fast and clearly on non-GitHub remotes.
- github.com users see no change.

Non-goals:
- GitLab / Bitbucket (separate plan).
- GHES versions out of GitHub support.
- Proxy support beyond documenting Node's options.
- `--insecure` TLS.

## Options considered

1. **Only `--api-url` / `GITHUB_API_URL`.** A tiny change, but every
   enterprise user must know their API URL. Remote detection still
   silently picks the wrong host. Tokens stay unpaired. Rejected as
   unsafe.
2. **Host-aware model**: parse the host from the remote, derive the API
   URL from it, resolve tokens per host with gh's conventions, and key
   storage by host, with `--host` / `--api-url` overrides. **Chosen.**
   It mirrors how `gh` behaves inside a checkout, so users' existing
   `gh auth login --hostname` setups just work.
3. **Delegate all API calls to `gh api`.** It gets host and auth for
   free, but it adds a hard dependency on `gh`, and pagination and
   streaming become harder. Rejected.

## Design

New pure module **`lib/github-host.mjs`**:

```js
parseRemote(url)  → { host, owner, repo } | { error: "not-github-shaped" } | null
  // https/http, ssh://[user@]host[:port]/, scp-like [user@]host:path; strips .git and trailing "/";
  // exactly two path segments, else error (GitLab subgroups); host lower-cased, port kept.
normalizeHost(host) → "github.com" for github.com, www.github.com, and SSH aliases "github.com-*"
hostKind(host)    → "dotcom" | "ghe.com" (host ends with ".ghe.com") | "ghes"
apiBaseUrl(host)  → dotcom: https://api.github.com · ghe.com: https://api.<sub>.ghe.com · ghes: https://<host>/api/v3
resolveHost({ flagHost, flagApiUrl, env, detected }) → { host, baseUrl, source }
```

**Host precedence.** The host travels with owner/repo:
1. `--api-url <url>` (explicit base URL, e.g. a non-standard port or
   path). The host is taken from the URL.
2. `--host <name>`.
3. If owner/repo came from the git remote, use the remote's host.
4. `GITHUB_API_URL`, only when `GITHUB_ACTIONS=true`. Actions sets it to
   the instance the workflow runs on.
5. `GH_HOST`.
6. `github.com`.

An unknown dotless SSH alias (`gh-work:o/r`) gives the error "can't tell
which GitHub host `gh-work` is — pass `--host`". Reading `~/.ssh/config`
is deliberately avoided (open question 2).

**Token per host** (`lib/github-client.mjs`):

| host kind | order |
|---|---|
| dotcom / ghe.com | `--token`, `GH_TOKEN`, `GITHUB_TOKEN`, `gh auth token --hostname <host>` |
| ghes | `--token`, `GH_ENTERPRISE_TOKEN`, `GITHUB_ENTERPRISE_TOKEN`, `GITHUB_TOKEN` *only if* `GITHUB_ACTIONS=true` and `GITHUB_API_URL`'s host equals the target, `gh auth token --hostname <host>` |

- `gh` is always called with `--hostname`. Being explicit also fixes the
  case where `GH_HOST` points elsewhere.
- `GH_TOKEN` is new for dotcom, so `gh` users with only `GH_TOKEN` set
  work. Open question 1 asks whether to keep this.
- `resolveToken` returns `{ token, source, host }` and never the token in
  messages.
- `createClient({ token, host, baseUrl })` →
  `new Octokit({ auth, baseUrl, userAgent })`.
- Errors name the host and the env var to set, never the value, for
  example: "No token for ghe.acme.corp. Run `gh auth login --hostname
  ghe.acme.corp` or set GH_ENTERPRISE_TOKEN."

**Storage keyed by host:**
- Cache: github.com keeps `<cacheDir>/<owner>__<repo>.json` (backwards
  compatible). Other hosts use `<cacheDir>/hosts/<host>/<owner>__<repo>.json`,
  where `<host>` is `[a-z0-9.-]+` and `:` becomes `_` (port; Windows-safe).
- Corpus `meta.host` is omitted for github.com and is the hostname
  otherwise. A corpus/target mismatch now compares `host/owner/repo`, so
  a corpus without `host` counts as github.com.
- MCP:
  - tools accept optional `host`, validated by `^[a-z0-9.-]+(:\d+)?$`;
  - `listRepos` walks `hosts/*` and returns `{ host, owner, repo }`;
  - the `NAME_RE` path-traversal guard applies to host too.

  Coordinate with 06, which removes the need to pass owner/repo.

**CLI surface:**
- `--host <name>` and `--api-url <url>` on `run`, `candidates`, `fetch`
  and `publish-corpus`.
- New help lines under "Environment": `GH_HOST`, `GH_ENTERPRISE_TOKEN`,
  `GITHUB_API_URL`.
- The progress line prints the host whenever it isn't github.com:
  "Detected acme/app on ghe.acme.corp from git origin."

**TLS.** Corporate GHES often uses an internal CA. Document
`NODE_EXTRA_CA_CERTS=/path/ca.pem`, which works in all supported Node
versions. Newer Node's `--use-system-ca` is unverified for 20.x. Do not
add an insecure switch.

## Implementation steps

1. `lib/github-host.mjs` (new) with a table-driven
   `test/github-host.test.mjs`.
2. `lib/git-info.mjs`: `detectRepoFromGit` returns `{ host, owner, repo,
   url }` via `parseRemote`. On `error` it returns
   `{ error, url }` so callers can say "origin is not a GitHub remote".
   Fix the trailing-slash case.
3. `lib/github-client.mjs`: per-host `resolveToken`, `createClient({
   host, baseUrl })`, host-aware error text.
4. `lib/cache.mjs`: add a `host` parameter to `cachePath`, `loadCache`,
   `mergeIntoCache` and `incrementalSince`, defaulting to github.com.
   Also update the lock path.
5. `lib/output.mjs` and `lib/corpus.mjs`: `meta.host`. The
   `publishCorpus` / `corpusInfo` match includes host.
6. `bin/reviewlore.mjs`, `bin/commands/fetch.mjs` and
   `lib/init-wizard.mjs`:
   - thread `host` and `baseUrl` through;
   - add the flags;
   - add host to the mismatch check (:324);
   - host-aware 401/403/404 hints.
7. `lib/mcp-tools.mjs` and `bin/commands/mcp.mjs`: optional `host`, and
   `listRepos` walks `hosts/`.
8. `skills/learn-from-reviews/SKILL.md`: in "No GitHub token", for a
   non-github.com host suggest `gh auth login --hostname <host>` or
   `GH_ENTERPRISE_TOKEN`. Never read credentials yourself (unchanged).
9. `scripts/check-pack.sh`: add `lib/github-host.mjs`.

## Tests & verification

All tests are hermetic: no network, no real tokens.

- `parseRemote`: every row of the table above, plus `http://`, uppercase
  hosts, `user:pass@` (credentials stripped; never returned),
  `file:///…` (null), and Windows-style paths (null).
- `resolveHost` precedence with an injected `env` object (no
  `process.env` mutation needed).
- Token resolution:
  - put a fake `gh` script on a temp `PATH` that records its argv into a
    temp file and prints `test-token`. Assert that `--hostname
    ghe.example` is passed and that a GHES host never picks up
    `GITHUB_TOKEN` outside Actions.
  - use placeholder strings only (`ghp_xxx` style is banned by
    check-secrets above 36 chars).
- `createClient` sets `baseUrl`, checked via
  `octokit.request.endpoint.DEFAULTS.baseUrl`. `JSON.stringify(client)`
  still does not contain the token (extends
  `test/github-client.test.mjs:63-72`).
- Cache:
  - github.com path unchanged;
  - GHES path under `hosts/`;
  - two hosts with the same owner/repo don't collide;
  - `listRepos` returns both.
- CLI, offline:
  - a temp git repo with a GHES origin plus a committed corpus with
    `meta.host` → `candidates --no-cache` works without a token;
  - the same repo with a github.com corpus is ignored with a warning;
  - a GitLab origin exits 1 with "not a GitHub remote".
- `isPlainIssueComment` with GHE URLs:
  `https://ghe.acme.corp/a/b/issues/3#issuecomment-1` → true; `/pull/3` →
  false.
- Manual check (needs an instance; owner or a volunteer):
  - on GHES ≥ the oldest supported version and on a GHE.com tenant, run
    `candidates` from a checkout using `gh auth login --hostname`;
  - confirm that rule URLs point at the instance, that GraphQL (03)
    works, and that `fullDatabaseId` exists (else 03 falls back to
    `databaseId`).

## Docs & changelog

- `README.md`: one line, "GitHub Enterprise Server and GHE.com: works
  from a checkout; see docs/cli.md#github-enterprise".
- `docs/cli.md`: a new "GitHub Enterprise" section covering host
  detection, flags, env vars, the token table and `NODE_EXTRA_CA_CERTS`.
- `TROUBLESHOOTING.md`:
  - 404 on an enterprise repo;
  - self-signed certificate errors (`UNABLE_TO_GET_ISSUER_CERT_LOCALLY`);
  - SSH alias needs `--host`.
- `examples/github-action/README.md`: works on GHES Actions unchanged
  (`GITHUB_API_URL`).
- CHANGELOG:
  - Added: GHES / GHE.com support.
  - Fixed: non-GitHub remotes were mis-parsed.
  - Security: tokens are only sent to their own host.

## Risks, compatibility & rollback

- **SSH aliases.** A user with `Host work` in `~/.ssh/config` pointing to
  github.com gets a new error where today they get a lucky success. The
  error text says to pass `--host github.com`. Mitigation: treat any
  dotless alias as github.com *only if* `GH_HOST` is unset and print a
  warning? This needs a decision (open question 2).
- **`GH_TOKEN` precedence.** It is new and could change which token is
  used for users who have both `GH_TOKEN` and `GITHUB_TOKEN` set.
  Today's `GITHUB_TOKEN` keeps priority if the owner prefers (open
  question 1).
- **Unverified on live instances:** GHES paths and `html_url` shape; the
  manual check gates the release.
- **Rollback:** github.com behaviour is unchanged by construction (same
  cache path, same token order apart from `GH_TOKEN`). Revert the
  feature commit.

## Cross-cutting checks

- **Credentials:** the core of this plan is host–token pairing.
  - Tokens are never sent cross-host and never echoed.
  - `user:pass@` in remote URLs is stripped and never logged (today the
    raw `url` is returned by `detectRepoFromGit`; drop it from logs).
  - Claude and the skill never read credential stores.
  - `gh auth token --hostname` is the user's own configured helper,
    called by the CLI as today.
- **Privacy:** no new data.
- **Determinism:** unaffected.
- **Deps:** none.
- **stdout/stderr:** host notices go to stderr.
- **Windows:** host directory names have no `:`. CI has no Windows
  runner, so file-name handling is covered by unit tests only.
- **Plugin vs CLI:** both use the same detection. MCP gains `host`.

## Success metrics

- `candidates` works from GHES and GHE.com checkouts with
  `gh auth login --hostname` and no flags (manual check).
- Zero requests to `api.github.com` from an enterprise checkout (assert
  in tests via the fake octokit's recorded baseUrl).
- GitLab remotes fail with a clear message instead of fetching `sub/proj`
  from github.com.
- All existing tests pass unchanged.

## Open questions for the owner

1. Add `GH_TOKEN` (gh convention), and should it go above or below
   `GITHUB_TOKEN`?
2. SSH host aliases: require `--host`, assume github.com with a warning,
   or resolve via `ssh -G <alias>`? The last reads the user's ssh config
   but no keys; check it against the credential-crawling rule.
3. What is the oldest GHES version to support (sets the GraphQL
   `fullDatabaseId` fallback in 03)?
4. Should a corporate HTTPS proxy be in scope? Node's `fetch` ignores
   `HTTPS_PROXY` by default in Node 20/22 (unverified for newer
   versions).
