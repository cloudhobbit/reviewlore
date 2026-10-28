# Audit history

Internal record mapping each shipped change to the audit pass that
identified it. Useful for future contributors to understand *why* a
given fix exists and what class of problem it addressed. Users
consuming `CHANGELOG.md` don't need this.

The toolkit went through three audit passes before its first release:

1. **Tier 1 / 2 / 3 audit** (correctness + design weaknesses + polish)
2. **Strategic / AI-systems audit** (semantic gaps, evaluation, LLM
   integration, cache, MCP)
3. **Product-usage audit** (onboarding, output format reach, demo
   path, error messages)

## Tier 1 — confirmed bugs (fixed in v0.1.0 baseline)

| # | Symptom | Fix |
|---|---|---|
| 1 | Heuristic dropped "avoid any types" because `any` was in stopwords | Keep `any`/`null`/`none`/`void`; fall back to full-sentence tokens when remainder is sparse |
| 2 | `--token` with no value silently authenticated as the literal `true` | Args parser throws `ArgsError` on missing values |
| 3 | `--out --per-month` swallowed the boolean flag as the value | Parser refuses to consume declared booleans as values |
| 4 | YAML frontmatter broke on colons / newlines in rep sentence | `yamlQuote()` for `name:` / `description:` |
| 5 | `isNoise` measured length AFTER stripping code/URLs | Use raw body length |

## Tier 2 — design weaknesses

| # | Concern | Fix |
|---|---|---|
| 6 | Re-runs silently clobbered hand-edited rules | Skip existing files by default; `--force` to overwrite |
| 7 | `--target` accepted any path, including typos | Validate exists + is dir; warn (non-fatal) if not git |
| 8 | Non-numeric `--min-occurrences` silently produced 0 clusters | Validate; clear error message |
| 9 | Progress logger emitted ANSI escapes to non-TTY stderr | TTY-aware; one-line-per-message when piped |
| 10 | Greedy clustering caused topic drift via growing union | Compare against compact centroid (top-K freq tokens, cap 6) |
| 11 | Clustering output was order-dependent | Sort candidates deterministically before clustering |
| 12 | Smoke test only exercised `--help` / `--version` | Added end-to-end fixture run inside extracted tarball |
| 13 | Release workflow didn't verify tag matches package.json | Added explicit `TAG != PKG` guard before publish |
| 14 | CI installed jq only on macOS; fragile if Ubuntu image changed | Defensive `command -v jq` guard on both OSes |
| 15 | Test coverage gaps in `fetchers`, `output`, `github-client` | Added unit tests (now 70 → eventually 121) |
| 21 | One verbose reviewer = N occurrences (inflated counts) | Count unique `(author, pr)` tuples |

## Tier 3 — docs polish (#17, #18, #19)

- README's `npx ... # not yet` hedge replaced with working examples.
- `docs/fetch-pr-comments.md` removed misleading `--out /dev/stdout` example.
- CHANGELOG entries written for human readers.

## Strategic audit — AI-systems engineering pass

| # | Gap | Fix |
|---|---|---|
| 1 | Signal blindness (PR-author self-comments, resolved threads, all comments weighted equally) | `lib/signals.mjs` |
| 2 | Every clustering / pattern change was "looks better to me" with no measurement | `eval/run-eval.mjs` with labeled fixtures, precision/recall/F1, CI regression gate |
| 3 | Jaccard misses synonyms (`unknown` vs `non-any`) | Pluggable similarity engines + TF-IDF cosine via `lib/similarity.mjs` |
| 4 | Output was the shortest source sentence, not a synthesised rule | Optional `--llm` via `lib/llm.mjs`, prompt-cached |
| 5 | 30 static rule files flood every Claude session's context | `bin/pr-comments-mcp.mjs` for on-demand querying |
| 6 | One-shot tool, no observability of convention evolution | `lib/cache.mjs` (incremental fetch) + `lib/diff.mjs` (rule-set diff) |

## Adversarial multi-agent round (v0.2.1)

Two workflows orchestrated this round:

- **`wy9ck0j89`** — 3 parallel finder agents (security, correctness,
  UX) → 2 skeptical verifiers per finding → 1 completeness critic.
  Surfaced 38 candidates; 31 survived skeptical verification.
- **`wzic65fga`** — triage agent picked the 6 highest-leverage
  survivors, then 6 parallel patch agents each produced concrete
  Edit-ready old_string/new_string pairs with failing-then-passing
  tests.

| # | Finder | Severity | Title | Fix landed in |
|---|---|---|---|---|
| 1 | security | high (downgraded) | MCP path traversal via owner/repo args | (validation patch deferred — listed for v0.2.2) |
| 2 | security | medium | Recommended commit of corpus persists pasted secrets in git history | `lib/secret-scan.mjs`, `publishCorpus` scan-before-write |
| 3 | correctness | lower-than-claimed | Concurrent runs corrupt cache (writeFileSync race) | (atomic-write patch deferred — listed for v0.2.2) |
| 4 | correctness | lower-than-claimed | `sinceFromMonths` drifts at month boundaries | `lib/filters.mjs` UTC arithmetic + day clamp |
| 5 | correctness | lower-than-claimed | Cluster sort is locale-dependent | (deferred — listed for v0.2.2) |
| 6 | UX | medium | `--months` validation missing in `run` subcommand | `bin/reviewlore.mjs` strict Number() check |
| 7 | UX | medium | Config-supplied preset silently ignored | `bin/reviewlore.mjs` preset-after-config ordering |
| 8 | UX | medium | `--target` failed in monorepo subdirectories | `lib/git-info.mjs` `findGitToplevel` helper |
| 9 | UX | medium | Diff-mode state never written by `run` | `lib/diff.mjs` shared helpers, both bins now wired |

The 5 deferred items (path traversal validation, cache atomic write,
locale-stable sort, plus ~22 lower-priority survivors) are slated for
the next round. The 6 that landed in v0.2.1 were the highest
leverage-per-LOC ratio.

### Round 2 (workflow `w33ptwapd`)

6 more findings closed before tagging v0.2.1:

| # | Finder | Severity | Title | Fix landed in |
|---|---|---|---|---|
| 10 | correctness | medium | Cluster sort tiebreaks use `localeCompare`, breaking cross-machine determinism | `lib/cluster.mjs` `binCmp` helper |
| 11 | correctness | medium | Concurrent runs corrupt cache (no atomicity, no lock) | `lib/cache.mjs` temp+rename + `O_EXCL` lock |
| 12 | correctness | medium | `diffClusters` matching not bijective (one previous claimed by two current) | `lib/diff.mjs` greedy sorted-by-score assignment |
| 13 | correctness | low | Reviewer-rescinded drop fires on PR-author-rooted threads, throwing away reviewer replies | `lib/signals.mjs` root-author guard |
| 14 | UX | medium | `run` + `publish-corpus` monthly refresh silently no-ops on second-and-later runs | `bin/reviewlore.mjs` cache top-up when both token + cache exist |
| 15 | UX | low | Init wizard accepts typoed `--format` tokens, fails later at run-time | `lib/init-wizard.mjs` `askFormatList` retry loop |

Cumulative v0.2.1: 12 of 31 survivors closed. The remaining 19 are
lower priority and slated for v0.2.2 — they include MCP-server input
hardening details, additional edge-case fixes, and several "could be
better" findings that don't yet have concrete repro cases.

## UX round (agent-genericity, HTML, wizard, presets)

| # | Concern | Fix |
|---|---|---|
| 1 | No shareable artifact for non-implementers | `--format html` self-contained dashboard |
| 2 | Users had to know which AI tool's format to pick | `--format auto` detects from target |
| 3 | Single-format-per-run limited mono-repo / multi-tool workflows | `--format a,b,c` multi-dispatch + `--format all` |
| 4 | "Read 8 flags and pick a threshold" onboarding | `init` wizard + `.reviewlore.json` config |
| 5 | "What threshold should I use?" had no answer | `--preset team-of-3 / oss-maintainer / new-joiner / monthly-refresh / team-of-50 / exploratory` |
| 6 | Only 5 of ~12 relevant AI-tool formats shipped | Added aider, agents, windsurf renderers |
| 7 | Cluster data lacked canonical shape for downstream consumers | `lib/renderers/_common.mjs` `Rule` schema; every renderer reads `Rule[]` |
| 9 | All comments weighted equally regardless of age | `--time-decay-half-life` (opt-in; some presets enable) |

## Product-usage audit

| # | Friction | Fix |
|---|---|---|
| P0 #2 | No way to try without a token and a target repo | `pr-comments-to-skills --demo` against bundled fixture |
| P1 #5 | Three commands required for the basic flow | `reviewlore run` one-shot orchestrator bin |
| P1 #6 | Users with `gh auth login` still had to set `GITHUB_TOKEN` | `gh auth token` fallback in `resolveToken` |
| P1 #8 | Claude Code-only output; excluded Cursor / Copilot / generic users | `--format claude\|cursor\|copilot\|contributing\|json` |
| Docs | "What's a GitHub token? Where do I get one?" unanswered | `TROUBLESHOOTING.md` + README "Don't have a token yet?" subsection |
| Docs | CHANGELOG referenced internal audit numbering | This file — keeps the audit history out of user-facing CHANGELOG |
