# 08 — Small and single-reviewer repositories

**Priority:** P1 for the single-maintainer mode and the mode-aware diagnosis; P2 for org-level learning · **Effort:** M (≈ 3 days: diagnosis wiring 0.5 on top of 12, single-maintainer mode 1, org-level 1.5) · **Depends on:** 12 (empty-result diagnosis and `history.prs/reviewers/top_reviewer_share` (plan 15)), 15 (`history.warning` thin/single-reviewer), 07 (raw mode for small sets); informs 13

> Scope note: plan 12 owns the general "nothing reached the bar" UX. This
> plan defines the modes the diagnosis points to (single-maintainer, longer
> window, pooled repos) and the order of suggestions. Plans 12 and 15 both
> add history stats to `candidates`; they should agree on one block (see
> Open questions).

_Status (October 2026): sections 1–3 implemented (diagnosis in `run`
and `candidates`, single-maintainer mode in CLI and skill, staleness
note). On the cached corpora `--single-reviewer` still yields 0 heuristic
rules for commander.js and swr, as this plan predicted; the plugin path
in single-maintainer mode is unmeasured (needs a model run). Section 4,
pooling related repos (P2), is not built: the audit found cross-repo
clusters on unrelated repos were all generic advice._

## Problem

On small projects the tool usually produces nothing. commander.js has one
maintainer who does almost all the reviewing. swr has a handful of human
review comments in six months. Both end with zero rules and no
explanation: the user can't tell "your repo has no recurring conventions"
apart from "the tool failed", and doesn't know what to try next. Most
repositories in the world are small, so this is the common first
experience, not an edge case.

## Audit findings

- **No diagnosis on zero.** `run` prints a single line, "No clusters met
  the thresholds. Try --min-occurrences 2 or a longer --months window."
  (`bin/reviewlore.mjs:469`). Lowering `--min-occurrences` doesn't
  help a single-reviewer repo, because `--min-authors 2` is what blocks it.
  `SKILL.md` has no zero-rules branch: step 3 always presents a table.
- **The evidence bar is fixed at two reviewers.** It's enforced by the
  skill (`SKILL.md` step 2.3) and by the CLI default `--min-authors 2`
  (`lib/extract.mjs:124-141`). The skill already lets the user ask for
  looser thresholds ("say which rules fall below the default bar").
  Nothing documents a single-reviewer mode or labels its rules.
- **Measured offline on the cached corpora** (scratch scripts; reviewers
  pseudonymised):

  | | commander.js (12 mo) | swr (6 mo) |
  |---|---|---|
  | PRs in window (`meta.pr_authors`) | 124 | 54 |
  | PRs with ≥ 1 human review comment after filters | 50 | 11 |
  | Comments after filters | 115 | 16 |
  | Distinct reviewers | 4 | 7 |
  | Top reviewer's share | 92% (99/108; 106 of 115 comments, on 45 PRs) | 33% |
  | Heuristic candidate sentences | 29 (26 from the top reviewer) | 5 |
  | Clusters with ≥ 2 PRs, any reviewer count (threshold 0.34 / 0.25) | 0 / 0 | 0 / 0 |
  | Clusters with ≥ 3 PRs from one reviewer | 0 | 0 |

  A single-reviewer "≥ 3 PRs" bar therefore surfaces **0** conventions
  through word-overlap clustering on either repo. Reading commander.js's
  29 candidates by hand, the most convention-like request ("The PR should
  not be updating the CHANGELOG") appears on one PR (#2384, twice). The
  rest are design discussion of individual PRs. The plugin path could
  still merge paraphrases across the 106 raw maintainer comments. My
  estimate of 0–2 rules is unverified and needs a model run (plan 13
  harness).
- **Org-level merging of unrelated repos only finds generic advice.**
  Clustering the five cached corpora together gives 37 clusters spanning
  ≥ 2 repos, all generic or logistics: "resolve conflicts" (9 PRs),
  "add a test case" (8 PRs), "fix CI", "is this needed?". Cross-repo
  evidence only helps when the repos share a team, and it then needs plan
  15's specificity filter, because generic context files tend to cost
  more than they help
  ([arXiv 2602.11988](https://arxiv.org/abs/2602.11988),
  [HF 2607.27250](https://huggingface.co/papers/2607.27250)).
- **Minimum data.** A comparable prompt-based miner reports output turning
  to noise below ~50 PRs
  ([Rush](https://rush.be/insights/mining-pr-comments-for-agent-review-rules)).
  Plan 15 adds `history.warning` = `thin` (< 50 PRs or < 3 reviewers) or
  `single-reviewer` (one reviewer ≥ 80% of comments) to `candidates`. This
  plan reuses those flags and doesn't redefine them.
- **Longer windows.** `--months` accepts any positive integer
  (`bin/reviewlore.mjs:287-291`). The commander.js cache only
  spans 12 months, so the yield of 24 months can't be measured offline.
  Fetch cost scales with PRs (one `listReviews` call per PR,
  `lib/fetchers.mjs:91-115`): ~250 extra requests for commander.js,
  roughly (unverified).
- **Cache and corpus are per-repo.** `cachePath(owner, repo)`
  (`lib/cache.mjs:35-37`), `corpusPath(target)` (`lib/corpus.mjs:32-34`),
  and the MCP tools take one owner/repo. Nothing merges repos.

## Goals / Non-goals

**Goals:** every zero (or near-zero) result explains itself with numbers
and offers concrete next steps. Give single-maintainer projects an
explicit, clearly labelled way to capture the maintainer's recurring
asks. Give multi-repo teams an opt-in way to pool evidence. Keep the
default bar (≥ 2 PRs and ≥ 2 reviewers) unchanged.

**Non-goals:** lowering defaults. Mining issues, commits or CONTRIBUTING
files (a separate idea). Org-wide rule files outside the target repo.

## Options considered

1. **Lower the defaults for small repos automatically.** Fewer zeros, but
   it breaks the precision-first promise exactly where evidence is
   thinnest, and noise is the top reason people abandon AI review tools
   ([tianpan.co](https://tianpan.co/blog/2026-04-17-ai-code-review-at-scale-false-positive-trap),
   [RedMonk](https://redmonk.com/kholterhoff/?p=356)). Rejected.
2. **Explain zero, plus three explicit opt-ins** (longer window,
   single-maintainer mode, org pool), each labelled in the output.
   **Chosen.** The UX part is cheap and helps every user. The opt-ins
   carry visible labels, so precision expectations stay honest.
3. **Org-level learning by default.** It needs multi-repo fetches and
   tokens for every repo, and on unrelated repos it yields only generic
   advice (measured above). Built as opt-in, P2.

## Design

### 1. Mode-aware empty-result diagnosis (extends plan 12)

Plan 12 adds the diagnosis and its stats. This plan adds a pure helper,
`diagnoseEmpty(stats, clusters)` in `lib/diagnose.mjs` (or inside plan
12's helper if it lands first), that returns ordered
`{ reasons[], suggestions[] }`, with the suggestions pointing at the modes
below. Example for commander.js:

```
No rules: nothing reached the bar (≥ 2 PRs and ≥ 2 reviewers).
  50 PRs had human review comments in 12 months; 1 reviewer wrote 92% of them.
  Strongest recurring request: 1 PR, 1 reviewer.
Next steps:
  • Single-maintainer repo? Re-run with the maintainer's preferences included:
      /reviewlore:learn-from-reviews single-maintainer
      (CLI: reviewlore run --single-reviewer)
  • Look further back: --months 24
  • Several repos maintained by the same team? See "Pool related repos" in docs/cli.md.
  • Zero can be the right answer: there may be no recurring conventions to learn.
```

- CLI `run`: replaces the line at `bin/reviewlore.mjs:469` (stderr).
- `candidates`: adds `"diagnosis": {reasons, suggestions}` to the header
  when the shown clusters contain none with `prs ≥ 2` and `reviewers ≥ 2`.
- SKILL.md: new step "If no rule passes the bar". Report the diagnosis in
  the user's terms, offer the options, and stop. Never quietly loosen the
  bar.

Reason rules: `history.warning === "single-reviewer"` → single-maintainer
suggestion first. `thin` → longer window first. Otherwise ("plenty of
review, nothing recurs") → "zero can be right", then raw mode (plan 07)
for paraphrase-heavy or non-English review.

### 2. Single-maintainer mode (labelled)

- **Bar:** ≥ 3 distinct PRs from 1 reviewer. A stricter PR count makes up
  for the missing second voice. The user may ask for ≥ 2, and the skill
  then says so in the table.
- **Skill:** argument `single-maintainer` (or the user saying so). Rules
  that pass only this bar get:
  - title prefix `Maintainer preference: …`
  - a body line `**Support:** one reviewer (@handle) on N PRs, which is
    below the team bar of 2 reviewers. Review before relying on it.`
    (with plan 11's anonymise option the handle becomes "the maintainer")
  - the same `pr-feedback-` file prefix (bulk delete still works), plus
    the provenance comment `(single-maintainer mode)`.
- **CLI:** `run --single-reviewer` sets `minAuthors = 1` and
  `minOccurrences = 3`, counted on distinct PRs. It adds the same label in
  `lib/skill-writer.mjs` when `cluster.distinctAuthors === 1`. Without
  the flag, nothing changes.
- **Mixed rules:** if a rule reaches ≥ 2 reviewers, it's a normal rule.
  The label only goes on rules that rely on the relaxation.

### 3. Longer windows

No new flag. The diagnosis suggests `--months 24` when
`history.prs < 50`. The skill warns that the first fetch of 24 months can
take several minutes and may be moved to the background by the Bash
tool (see plan 04's timeout handling and plan 12's fetch estimate). Rules from old comments carry `last_seen`
in `candidates`. The skill drops a rule whose newest support is older
than 18 months unless the user keeps it.

### 4. Pool related repos (P2, opt-in)

```
reviewlore candidates --pool owner/a,owner/b[,…]
```

- Loads each repo's cache or committed corpus (fetching if needed, same
  token rules). Tags every candidate with `repo`, prefixes reviewer and PR
  keys with the repo, and clusters across all of them.
- **Cross-repo evidence bar:** at least 2 PRs and 2 reviewers overall,
  **and** at least 1 supporting PR in the target repo (the rule must have
  been asked for here). Clusters supported only by other repos go into a
  separate `elsewhere` list, shown for information and never written.
- `globs` are kept only for target-repo paths. Quotes from other repos
  are cited with their full URLs.
- **Specificity:** cross-repo clusters lean generic (measured above), so
  plan 15's "repo-specific, not generic" check is mandatory in pool mode.
- Limit: ≤ 10 repos. Every repo must share the target's owner (the
  owner/org is the trust boundary). A different owner is refused with an
  explanation.

## Implementation steps

1. `lib/diagnose.mjs` (new, pure; or an extension of plan 12's helper) +
   tests. Wire it into `run` (stderr) and `candidates` (header field)
   where plan 12 prints its diagnosis. Add any new file to
   `scripts/check-pack.sh`.
2. `skills/learn-from-reviews/SKILL.md`: "If no rule passes the bar"
   section, `single-maintainer` argument (update `argument-hint`), the
   label format, the staleness note.
3. `bin/reviewlore.mjs`: `--single-reviewer` for `run`, which
   maps to thresholds plus the label. `lib/skill-writer.mjs` and
   `lib/renderers/_common.mjs`: render the label when
   `distinctAuthors === 1`.
4. (P2) `lib/pool.mjs` (pure merge and tagging) and `--pool` in
   `candidates`. Validate repo names against the same owner/repo pattern
   the MCP tools use.
5. Docs and CHANGELOG.

## Tests & verification

- `test/diagnose.test.mjs`: single-reviewer, thin, and plenty-but-no-
  recurrence fixtures produce the expected reason order. A non-empty
  result gives no diagnosis.
- `test/cli.test.mjs`: `run` on a single-reviewer fixture prints the
  diagnosis on stderr and nothing on stdout. `--single-reviewer` writes a
  rule with `Maintainer preference:` and the support line, and without the
  flag writes nothing.
- `test/pool.test.mjs`: the cross-repo bar (a cluster with no target-repo
  PR goes to `elsewhere`), keys can't collide across repos, and a
  different owner is refused.
- Offline measurements to re-run after implementation (scratch scripts in
  this plan's audit): commander.js and swr with `--single-reviewer`
  (expected 0 from the heuristic; recorded in
  `examples/real-repos/*/README.md`), and the plugin path in
  single-maintainer and raw mode via plan 13's harness (record the rule
  count and the owner's keep/drop judgement).
- `eval:real` is unaffected (extraction unchanged).

## Docs & changelog

README "What to expect" (zero is explained, and the options).
`docs/how-it-works.md` "Limitations" (single-maintainer mode, pool).
`docs/cli.md` (`--single-reviewer`, `--pool`). `examples/real-repos/README.md`
(commander.js/swr rows link to their diagnosis output). CHANGELOG.

## Risks, compatibility & rollback

- Single-maintainer rules are one person's taste. The label and the
  support line keep that visible, and the 3-PR bar limits one-off remarks.
- Pool mode spends tokens on several repos and can leak conventions
  across teams. Hence opt-in, the same-owner restriction, and the
  target-repo-PR requirement.
- Everything is additive. Defaults are unchanged. Rollback means removing
  the flags and the skill section.

## Cross-cutting checks

- **Credentials:** pool mode resolves the token once, as today. No new
  token sources.
- **Privacy:** single-maintainer rules name one person prominently, so
  plan 11's anonymise option applies. Pool mode quotes reviewers from
  other repos, so the data-handling statement must mention it.
- **Determinism:** diagnosis is a pure function of the data. Pool order
  follows the sorted repo list.
- **Deps:** none. **stdout/stderr:** the diagnosis goes to stderr for
  `run` and into the JSON for `candidates`.
- **Windows:** no shell use. **Plugin vs CLI:** both get the diagnosis.
  Pool mode is CLI `candidates` only, which the skill can call.

## Success metrics

- 100% of zero-rule runs (CLI and skill) print a diagnosis with ≥ 1
  numeric reason and ≥ 1 suggestion.
- commander.js: the diagnosis names the single-reviewer cause.
  Single-maintainer mode output is reviewed by the owner, and whatever it
  writes is kept by them (≥ 2/3 kept, the Rush curation baseline).
- No change in rule counts for vitest, pnpm and express at defaults.

## Open questions for the owner

1. Single-maintainer bar: ≥ 3 PRs (proposed) or ≥ 2 as the brief
   suggested?
2. Should pool mode ship at all before there's a user with several small
   repos sharing one team?
3. Drop stale support (> 18 months) by default, or only flag it?
4. ~~Plans 12 and 15 both add history stats~~ — resolved in review:
   plan 15's `history` block (`prs`, `reviewers`, `top_reviewer_share`,
   `warning`) is the single shape; plan 12 uses it.
