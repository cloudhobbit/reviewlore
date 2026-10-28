# 11 — Privacy and trust

**Priority:** P1 (the README correction and the secret-scan fixes are P0 before a public release) · **Effort:** M (≈ 4 days: scanning 1.5, anonymise 1, data statement + docs 0.5, opt-out/redaction 1) · **Depends on:** 05 (slim corpus: fewer handles, scans `path`/drops `diff_hunk`); touches 07 (raw mode sends whole comments), 08 (single-maintainer rules name one person), 13 (checker verifies anonymised output), 14 (new token patterns)

## Problem

The toolkit copies colleagues' words into files that get committed and
loaded into AI sessions: rule files quote reviewers by GitHub handle, and a
committed corpus holds every comment with its author. Reviewers never
agreed to that and have no way to opt out. The README promises that
"Everything runs on your machine", but in the plugin path Claude Code
sends the review quotes to the model provider. Pasted credentials are
caught only on one of the many paths a comment body can take. Teams need a
privacy story they can repeat to their security reviewer, and that story
has to be true.

## Audit findings

**What is fetched** (`lib/fetchers.mjs`): every PR conversation comment,
inline review comment and review body in the window, with author login
and type, body, `path`/`line`, `diff_hunk` (code), timestamps, `html_url`
and PR titles, plus `meta.pr_authors`, the login of every PR author in
the window (`fetchers.mjs:86-89`).

**Where it is stored:**

| Artefact | Location | Contents | Secret scan |
|---|---|---|---|
| Cache | `~/.reviewlore/<owner>__<repo>.json` (`lib/cache.mjs:31-37`) | everything fetched; merged forever. Deleted comments are never removed (`mergeIntoCache` only adds/overwrites, `cache.mjs:58-101`) | none |
| Cache permissions | written with default modes (`saveCache`, `cache.mjs:105-117`) | on this machine: dir `drwxr-xr-x`, files `-rw-r--r--`, so other local users can read them | — |
| `fetch` output | cwd by default (`bin/commands/fetch.mjs:73,139-142`) | full raw JSON. Running `fetch` inside a repo drops it into the working tree | none |
| Committed corpus | `<repo>/.reviewlore-corpus.json` (`lib/corpus.mjs`) | the cache (plan 05 slims it) | **yes**: `publishCorpus` redacts by default (`corpus.mjs:92-109`) |
| `candidates` output / skill temp file | stdout → `mktemp -t pr-feedback.XXXXXX` (`SKILL.md` step 1) | request sentences, handles, URLs, paths. Removed only at step 5, so an aborted run leaves it in `$TMPDIR` | none |
| Rule files | `.claude/rules/pr-feedback-*.md` | ≥ 2 verbatim quotes + `@handle` + URL per rule (`SKILL.md` step 4; `lib/skill-writer.mjs:22-25`). The heuristic "Why" lists up to 5 handles (`skill-writer.mjs:124-127`) | none |
| Other renderers | Cursor/HTML/JSON (`lib/renderers/cursor.mjs:51`, `html.mjs:44,90`, `json.mjs:31-35`) | handles and quotes | none |
| State file | `.reviewlore-state.json` (`lib/diff.mjs:38-52`) | labels and counts only, no handles | n/a |
| MCP responses | `recent_feedback` returns `author` (`lib/mcp-tools.mjs:100`) | handles and comment text, into the model context | none |
| Eval set | `eval/real/comments.json` | authors pseudonymised (`eval/real/sample.mjs:35-48`) but `html_url` kept, and a URL resolves to the author on GitHub. `eval/real/README.md` says the URLs are kept, but "pseudonyms" overstates the protection | n/a |

**What leaves the machine:**

- GitHub API calls carrying the user's token (`lib/github-client.mjs`).
- **Plugin path:** Claude reads the `candidates` file and MCP results, and
  Claude Code sends that content to whatever model provider it's
  configured for (Anthropic API, or Bedrock / Vertex / Foundry). Raw mode
  (plan 07) sends whole comments.
- **`--llm`:** up to 8 sentences and 8 paths per cluster go to the
  Anthropic API (`lib/llm.mjs:47-59`). Handles aren't sent, and the
  prompt forbids names in output (`llm.mjs:43`).
- README "Privacy" says "Everything runs on your machine." **This is
  inaccurate** for both paths above.

**Secret scanning:**

- `lib/secret-scan.mjs` is imported only by `lib/corpus.mjs` (grep: no
  other caller), so it runs on `publish-corpus` only. The cache, `fetch`
  output, `candidates`, MCP responses, rule files, renderers and `--llm`
  prompts are all unscanned.
- `candidates` keeps `inline code` (`extract.mjs:28`,
  `keepInlineCode: true`), so a token pasted in backticks inside a request
  sentence can reach a rule file as a "verbatim quote".
- **Pattern gaps, tested with fake strings** against `scanText`: missed
  PKCS#8 `-----BEGIN PRIVATE KEY-----`, `ENCRYPTED PRIVATE KEY`, GitHub
  `ghu_`/`ghr_`, npm `npm_`, GitLab `glpat-`, Google `AIza…`, Stripe
  `sk_live_`, JWTs, Atlassian `ATATT…`. Caught: `ghp_`. The PEM regex
  requires `RSA|EC|OPENSSH|PGP` (`secret-scan.mjs:19`).
- **`scripts/check-secrets.sh` prints the matching lines** (`echo
  "$MATCHES"`, line 45) into CI logs. That echoes the credential, which
  `.claude/rules/no-token-logging.md` forbids.
- Plan 05 found `diff_hunk` and `pr_title` unscanned in the published
  corpus. Its fix (drop or scan them) is assumed here.

**Consent / opt-out:** no `--exclude-author`, no per-comment redaction,
no record of redaction requests. `lib/corpus.mjs:19-23` argues a
committed private-repo corpus is "no new exposure". That ignores forks,
former members and `git log` persistence after a comment is deleted on
GitHub.

**A strength worth stating:** hosted review tools keep what they learn on
their own servers (e.g. Greptile's learned memory,
[docs](https://www.greptile.com/docs/how-greptile-works/memory-and-learning)).
Here everything learned lives in the user's repo and home directory, as
reviewable text files, with no service holding it.

## Goals / Non-goals

**Goals:** a true, short data-handling statement. Anonymised rule output
as an option. Secret scanning on every path a comment body takes to disk
or to a model. A documented opt-out/redaction path for reviewers. Private
cache permissions. No leftover temp files.

**Non-goals:** a DLP product, legal advice, encryption at rest,
scrubbing GitHub itself. Anonymity against a determined reader (quotes
are searchable on GitHub, so anonymising lowers prominence, not
findability).

## Options considered

1. **Anonymise by default.** Safer, but rules become harder to check
   (who said it matters to teammates) and it changes output for existing
   users. Rejected as the default, offered as a flag.
2. **Anonymise as an opt-in (`--anonymize` / skill argument), plus
   scanning everywhere, plus a data statement.** **Chosen.** Additive and
   cheap. URLs are kept by default (they make the evidence checkable),
   with a stricter `--anonymize=strict` that drops them too.
3. **Stop quoting at all (counts plus URLs only).** Loses the main trust
   feature ("read the quotes and judge"). Rejected.

## Design

### Data-handling statement (README "Privacy", full text in `docs/privacy.md`)

> **What's read:** PR review comments, review summaries and PR authors
> for the window you choose, using your GitHub credentials.
> **Where it's stored:** `~/.reviewlore/` (private to your user
> account), and in your repo only if you run `publish-corpus` or write
> rules. Nothing is sent to us. There is no server.
> **What leaves your machine:** requests to GitHub. In the Claude Code
> plugin, the review quotes Claude reads are sent to your model provider
> like anything else in your session. With `--llm`, review sentences (no
> usernames) go to the Anthropic API.
> **Who is quoted:** rules quote reviewers by handle with links. Use
> `--anonymize` to replace handles with "a reviewer".
> **Opting out:** see "If you're a reviewer" in `docs/privacy.md`.

### Anonymise

- Rule quote line: `— a reviewer on PR #123: <url>` (default anonymise)
  or `— a reviewer on PR #123` (`strict`). Within one rule, distinct
  reviewers become `reviewer A`, `reviewer B` so "2 reviewers" stays
  checkable.
- Heuristic "Why" lists counts only. HTML/JSON renderers use the same
  mapping.
- Skill: argument `anonymize` (and `strict`). SKILL.md step 4 shows both
  formats. Plan 13's checker verifies no `@handle` appears outside
  citations, and none at all in anonymise mode.
- Quotes that contain an @mention are already stripped of it
  (`normalize.mjs:32`).

### Scan everywhere a body is written or sent

- Extend `SECRET_PATTERNS` (kept in sync with `check-secrets.sh`): generic
  PEM `-----BEGIN [A-Z ]*PRIVATE KEY-----`, `gh[pousr]_`, `npm_[A-Za-z0-9]{36}`,
  `glpat-[A-Za-z0-9_-]{20,}`, `AIza[0-9A-Za-z_-]{35}`, `sk_live_[0-9A-Za-z]{24,}`,
  `xox[abprs]-`, JWT `eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.`,
  Atlassian `ATATT[A-Za-z0-9_=-]{20,}`. Each new pattern gets a fake-value
  test.
- Apply `redactText` at the **fetch boundary**, in
  `buildOutput`/`mergeIntoCache`. Then the cache, `fetch` output, corpus,
  candidates, MCP and rules all inherit clean bodies. `publishCorpus`
  keeps its scan as a second line of defence for old caches. Print a
  count, never the value.
- `check-secrets.sh`: print `file:line [label]` only, never the matched
  text.

### Reviewer opt-out and redaction requests

- `.reviewlore-ignore` (repo root, committed), one entry per line:
  `author:<login>` (drop all their comments), `comment:<html_url>` (drop
  one), `#` comments. It's applied in `applySignals` before anything else.
  `publishCorpus` removes matching records from the published corpus.
- `docs/privacy.md` "If you're a reviewer": ask the repo maintainers to
  add you to the ignore file, delete the generated rules quoting you, and
  re-publish the corpus. Explain that git history keeps old corpus copies
  unless rewritten.
- Deleted-on-GitHub comments: `fetch --cache --prune` re-lists the window
  and removes cached records whose ids no longer appear (opt-in; costs a
  full re-fetch of the window).

### Local hygiene

- `saveCache`: `mkdirSync(dir, { mode: 0o700 })` and
  `writeFileSync(tmp, …, { mode: 0o600 })`. Existing dirs/files are
  `chmod`-ed on next write (POSIX only; a no-op on Windows).
- `fetch` warns when `--out` resolves inside a git working tree and the
  file isn't ignored.
- Skill temp file: SKILL.md says to delete the file on every exit path,
  including when the user cancels at step 3 or no rule passes. Prefer plan 04's
  `candidates --save` path inside `$TMPDIR` with a fixed name per repo,
  overwritten each run, so at most one copy exists.
- `eval/real/README.md`: say plainly that URLs re-identify authors. The
  pseudonyms only keep handles out of the file.

## Implementation steps

1. `lib/secret-scan.mjs` + `scripts/check-secrets.sh`: new patterns,
   no value echo; tests.
2. `bin/commands/fetch.mjs`, `bin/reviewlore.mjs` (fetch and
   top-up paths), `lib/output.mjs`: redact at build time; stderr count.
3. `lib/cache.mjs`: private modes; `--prune` in `fetch`.
4. `lib/ignore.mjs` (new, pure parser) + `lib/signals.mjs` hook +
   `lib/corpus.mjs` filtering; `scripts/check-pack.sh`.
5. Anonymise: `lib/skill-writer.mjs`, `lib/renderers/_common.mjs`,
   `html.mjs`, `cursor.mjs`, `json.mjs`; `--anonymize[=strict]` flag in
   `run`/`generate`; SKILL.md argument and step 4/5 text.
6. Docs: README Privacy rewrite, new `docs/privacy.md`, `eval/real/README.md`,
   `lib/corpus.mjs` header comment corrected.

## Tests & verification

- `test/secret-scan.test.mjs`: every new pattern catches a fake value and
  leaves benign prose alone (e.g. "the npm_config var", "AIza" in prose
  shorter than the pattern).
- `test/fetchers.test.mjs` / `test/cache.test.mjs`: a fake `ghp_` in a
  body is `[REDACTED]` in the cache. File mode is 0600 (skip on win32).
- `test/signals.test.mjs`: ignore-file entries drop authors and single
  comments. `test/corpus.test.mjs`: the published corpus excludes them.
- `test/skill-writer.test.mjs`, `test/renderers.test.mjs`: anonymise and
  strict outputs contain no `@` handle and keep the reviewer-letter count.
- `scripts/check-secrets.sh` test: a planted fake key prints
  `file:line [label]` without the key.
- Manual: run the skill with `anonymize` on vitest's corpus. Plan 13's
  checker passes in anonymise mode.

## Docs & changelog

README "Privacy" (statement above), `docs/privacy.md` (new),
`docs/cli.md` (`--anonymize`, `--prune`, ignore file),
`docs/how-it-works.md` "Limitations", `eval/real/README.md`, CHANGELOG
`[Unreleased]` (Security: scan coverage, no echo in check-secrets,
private cache modes).

## Risks, compatibility & rollback

- Redacting at fetch changes cached bodies (only where a credential
  pattern matched). Clustering is unaffected in practice.
- A broader pattern set raises false redactions in code-heavy comments,
  e.g. JWT-looking test fixtures. They're replaced with `[REDACTED]`, not
  dropped, and the count is reported.
- The ignore file is itself a list of logins in the repo. Document that
  it's optional and can be kept outside the repo via `--ignore-file`.
- All additive. Rollback per step.

## Cross-cutting checks

- **Credentials:** no new sources. The scanner never returns matched text.
  `check-secrets.sh` stops echoing.
- **Privacy:** the subject of this plan. Fewer handles in output when
  anonymised, private cache, opt-out path.
- **Determinism:** reviewer letters are assigned in quote order.
- **Deps:** none. **stdout/stderr:** redaction counts go to stderr.
- **Windows:** file modes are a no-op. Cache privacy relies on the
  per-user profile directory.
- **Plugin vs CLI:** scanning at fetch covers both. Anonymise is in both.

## Success metrics

- README statement reviewed and accepted by the owner. No sentence in it
  is false (checked against this audit's table).
- 0 unscanned paths from fetch to disk or model (grep: every writer
  receives redacted bodies).
- All 10 fake-credential probes above are caught. `check-secrets.sh`
  output contains no matched values.
- Anonymise mode: plan 13 checker reports 0 handles in rule bodies on
  the three gallery repos.

## Open questions for the owner

1. Keep URLs in anonymised rules by default (checkable, but
   re-identifiable), or default to `strict`?
2. Should `publish-corpus` drop handles entirely (hashing them), given
   that plan 05 already cuts them from 687 to 112 on pnpm?
3. Ship the ignore file in the repo, or only support `--ignore-file`
   outside it?
