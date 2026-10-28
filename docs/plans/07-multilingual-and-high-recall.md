# 07 — Multilingual and high-recall input for the plugin ("raw" candidates)

**Priority:** P1 · **Effort:** M (≈ 4–5 days: 2 code, 1 skill, 1–2 eval) · **Depends on:** 13 (AI-reviewer filter, skill-output eval); pairs with 08 (small repos) and 15 (specificity)

_Status (October 2026): implemented (steps 1–5): `lib/raw.mjs`,
`candidates --raw`, review-state inheritance via `pull_request_review_id`
(named so it doesn't clash with a review's own `review_id`), the skill's
mode choice and raw-mode synthesis, and the raw-ceiling column in
`eval:real` (60/60). Not done: the pooled rule-level recall comparison
(needs plan 13's skill harness and the owner's labels) and a non-English
repo (the owner picks one)._

## Problem

The plugin's `learn-from-reviews` skill only ever sees sentences that the
English phrase classifier in `lib/patterns.mjs` recognised as requests. A
team that reviews in German, Japanese or Portuguese gets an empty
`candidates` file and zero rules. English teams lose too: a reviewer who
writes "This belongs in the existing suite." with no "please"/"should"/
"don't" never reaches Claude. On the held-out repos, a third of the review
requests a human would count never get past the classifier.

## Audit findings

- **The classifier sits in front of the model.** `emitCandidates`
  (`bin/reviewlore.mjs:539-584`) calls `extractCandidates`
  (`lib/extract.mjs:23-60`), which keeps a sentence only if
  `classifySentence` matches an English phrase pattern
  (`lib/extract.mjs:30-31`). The skill (`skills/learn-from-reviews/SKILL.md`
  step 1) reads only that output.
- **The upstream filters are language-agnostic.** `applySignals`
  (`lib/signals.mjs:55-168`: plain-issue comments, PR authors' own
  comments, resolved threads, state weights) and `isNoise`
  (`lib/normalize.mjs:87-99`: bot type/name, raw body < 20 chars, praise)
  use metadata, not phrasing. Exceptions: `PRAISE_RE` and the
  resolved-thread regexes (`RESOLVED_BY_AUTHOR_RE`, `signals.mjs:21-24`)
  are English, so non-English "done"/"erledigt" replies and praise would
  survive. That fails safe: more input, no lost feedback.
- **Measured on the cached corpora (offline, scratch script; chars/4 token
  estimate).** Comments that survive `applySignals` + `isNoise`:

  | Repo | Comments | Survive filters | Text tokens (cleaned) | JSONL with metadata, 1,200-char cap | Comments the heuristic extracts from |
  |---|---|---|---|---|---|
  | vitest (6 mo) | 6,154 | 1,198 | ~40k | ~77k | 469 |
  | pnpm (6 mo) | 8,623 | 762 | ~35k | ~57k | 295 |
  | express (12 mo) | 1,384 | 577 | ~50k | ~51k | 200 |
  | commander.js (12 mo) | 535 | 115 | ~4.3k | ~7.3k | 21 |
  | swr (6 mo) | 170 | 16 | ~0.8k | ~1.3k | 5 |

  For comparison, today's `candidates` on pnpm is 63 KB (~16k tokens).
  Comment length after cleaning: p50 87–151 chars, p90 274–692, max 7,715
  (express).
- **Recall ceiling on the labelled set.** On `eval/real/comments.json`,
  34/35 dev and 25/25 held-out positives survive the language-agnostic
  filters (the one dev miss, "@user add test in test/ui", drops only
  because my scratch filter also required ≥ 20 *cleaned* characters; with
  `isNoise`'s raw-length rule it survives). The survivors also include
  24 (dev) and 45 (held-out) labelled negatives, so the model has to
  reject roughly 1 in 2. The heuristic's held-out recall is 64.0%
  (16/25).
- **No non-English data exists offline.** 0 survivors in all five corpora
  have more than 30% non-ASCII characters. Any multilingual claim needs
  new data (see Tests).
- **AI reports dominate express's raw text.** 30 comments from 3 user
  accounts (an "Orb Code Review … powered by GLM" bot and a templated
  "Hi, … Severity" reviewer) are 37.6% of the surviving text. Raw mode
  makes this worse because nothing drops their non-request sentences.
  Plan 13 adds the filter.
- **Ranking inputs are weaker than they look.** Inline review comments
  always get weight 1.0 (`signals.mjs:158`) because `fetchReviewComments`
  doesn't store `pull_request_review_id` (`lib/fetchers.mjs:45-59`), so an
  inline comment inside a CHANGES_REQUESTED review isn't up-weighted.
  Only review bodies carry state.
- **Sampling loses the evidence the gallery cites.** Simulated budgets
  (rank by state weight × 6-month recency decay, round-robin by top-level
  directory, AI-like comments removed), counting how many quotes cited in
  `examples/real-repos/*/plugin` stay in the sample:

  | Budget | vitest | pnpm | express |
  |---|---|---|---|
  | 15k tokens | 3/18 | 5/16 | 9/11 |
  | 30k tokens | 12/18 | 11/16 | 9/11 |
  | 60k tokens | 18/18 | 16/16 | 11/11 |

  Sampling is a last resort. A typical repo's whole survivor set fits in
  60k tokens.
- **Acted-on feedback is thrown away.** Resolved threads, where the PR
  author replied "fixed"/"done", are dropped (`signals.mjs:98-127`):
  135 review comments on vitest, 397 on pnpm. Keeping them would add
  +37 / +31 candidates and leave CLI rule counts unchanged. Greptile
  treats "was the comment addressed" as a *positive* learning signal
  ([docs](https://www.greptile.com/docs/how-greptile-works/memory-and-learning)).
  Today's logic assumes the convention is already in the code. That holds
  for the code but not for the next contributor, so it's an open tension
  (see Open questions).
- Not verified: how well Claude synthesises from 50–80k tokens of raw
  comments compared with 16k of clustered quotes. That needs the plan 13
  eval.

## Goals / Non-goals

**Goals:** feed Claude human review comments in any language, within a
stated token budget. Raise rule recall on paraphrase-heavy English repos
without lowering the evidence bar. Measure the gain cheaply.

**Non-goals:** changing the CLI heuristic, `run`, or `eval:real` floors.
Translating comments. Multilingual phrase patterns in `lib/patterns.mjs`
(the precision of translated patterns can't be checked without
per-language labels). Lowering the ≥ 2 PRs / ≥ 2 reviewers bar.

## Options considered

1. **Add phrase patterns for more languages.** Cheap per language, but
   unbounded work, and it can't be evaluated without labelled data in each
   language. Rejected.
2. **Raw mode: skip the classifier, keep the language-agnostic filters,
   hand Claude whole comments under a budget.** One code path for every
   language, and recall bounded only by the filters (97–100% on the
   labelled set). Costs 3–5× the tokens of `candidates`. **Chosen.**
3. **Hybrid: clustered candidates plus "unclassified" comments as an
   appendix.** Smaller than raw for English repos, but two formats for the
   skill to reason about, and the appendix is raw mode anyway. Kept as a
   follow-up if the plan 13 eval shows raw mode loses precision on
   English repos.

## Design

### CLI: `candidates --raw`

```
reviewlore candidates --raw [--budget <tokens>] [--max-chars <n>]
```

- Same repo, corpus and window resolution as `candidates`. Runs
  `applySignals` and `isNoise`, plus plan 13's AI-review filter. No
  classifier and no clustering.
- `--budget` defaults to 60000 estimated tokens (chars / 4).
  `--max-chars` (default 1200) truncates long comments with `…`.
- Output on stdout: one header line, then one comment per line (JSONL), so
  the skill can read it in chunks:

```json
{"repo":"pnpm/pnpm","since":"…","mode":"raw","stats":{"comments":8623,"survivors":762,"shown":762,"truncated":41,"budget_tokens":60000,"est_tokens":51541,"dropped_for_budget":0,"non_ascii_share":0.0}}
{"u":"11234#discussion_r1","by":"alice","pr":11234,"k":"review_comment","state":null,"path":"pkgs/core/src/x.ts","at":"2026-03-02","text":"…"}
```

  `u` is the URL suffix after `/pull/`. The skill rebuilds the full URL as
  `https://github.com/<repo>/pull/<u>` for citations. Plan 14 replaces
  this with a provider-supplied URL builder.
- **Ordering and budget.** Sort by `weight × 0.5^(age_months/6)` (review
  comments ×1.25: they're anchored to code). Then round-robin across
  top-level directories (`pathGlobs` roots, plus "unscoped") so one hot
  package can't take the whole budget. Fill greedily until the budget is
  spent. Ties break on URL, so the output is deterministic for a given
  corpus and `now` (`meta.fetched_at`, not the wall clock).
- `stats.non_ascii_share` is the share of shown comments whose text is
  ≥ 30% non-ASCII letters. The skill uses it to explain the mode choice.
  It's not used for filtering.
- Stderr: `762 review comments after filtering (≈ 51.5k tokens); printed 762.`

### Store the review id (small fetch change)

Add `review_id: c.pull_request_review_id ?? null` to review comments in
`lib/fetchers.mjs`. In `applySignals`, give an inline comment the state
weight of its parent review when that review is in the corpus. Old
corpora lack the field and keep weight 1.0. This improves ranking in both
modes.

### Skill changes (`skills/learn-from-reviews/SKILL.md`)

- Step 1 runs `candidates` as today. Switch to (or offer) raw mode when:
  (a) the user asks ("all comments", "our reviews are in Japanese");
  (b) `stats.candidates` < 20 while comments after filtering exceed 50.
  The skill can't see the second number today, so plan 15's `history`
  block or a new `stats.survivors` field supplies it; or
  (c) the whole raw set is small (plan 08: commander.js ≈ 7k tokens).
  One line tells the user which mode it chose and why.
- Raw-mode synthesis instructions: read the file in chunks of ~300 lines.
  Note candidate conventions with the `u`, author and PR of each
  supporting comment. Apply the same evidence bar. Quote the shortest
  sentence (or phrase, for languages without sentence punctuation) that
  states the request, verbatim, in the original language. Write the rule
  text in the language the user is chatting in, unless they ask
  otherwise. Ignore praise, status updates and logistics in any language.
- If `stats.dropped_for_budget > 0`, say so and offer `--budget`.

## Implementation steps

1. `lib/raw.mjs` (new, pure): `rawComments(data, { budget, maxChars, now })`
   → `{ stats, rows }`, reusing `applySignals`, `isNoise`, `stripMarkdown`
   and `pathGlobs`. Add it to `scripts/check-pack.sh` REQUIRED.
2. `bin/reviewlore.mjs`: parse `--raw`, `--budget`, `--max-chars`
   (positive integers, validated like `--limit`). Add `emitRaw`. Update
   HELP.
3. `lib/fetchers.mjs` + `lib/signals.mjs`: store `review_id` on review
   comments and inherit the review state weight.
4. `skills/learn-from-reviews/SKILL.md`: the mode choice, the raw-mode
   synthesis section, multilingual quoting.
5. `eval/raw/` (see Tests), docs, CHANGELOG.

## Tests & verification

- `test/raw.test.mjs` (hermetic fixtures): filters applied, no classifier
  (a German "Bitte einen Test ergänzen" fixture survives), budget
  respected, round-robin by directory, stable order on ties, truncation
  marker, `non_ascii_share`.
- `test/cli.test.mjs`: `candidates --raw` on a fixture corpus (JSONL shape,
  header first, nothing but JSON on stdout), plus flag validation errors.
- `test/signals.test.mjs`: inline comment inherits CHANGES_REQUESTED
  weight via `review_id`. Old-shape corpora are unchanged.
- **Recall without a labelling explosion:**
  1. *Comment-level ceiling (free).* Add a `--raw` column to
     `eval/run-real-eval.mjs`: share of labelled positives that survive
     the raw filters. Today 97–100%. Track it so filter changes can't
     silently cut recall.
  2. *Rule-level pooled recall (cheap).* For vitest, pnpm and express, run
     the skill in both modes (3 runs each, via plan 13's harness). Pool
     the union of proposed rules (expected ~10–15 per repo). The owner
     labels each pooled rule once as keep or drop (≈ 1 hour per repo,
     TREC-style pooling). Recall = kept rules found by the mode / all kept
     rules in the pool; precision = kept / proposed. Only the pool is
     labelled, never all comments.
  3. *Multilingual (new data, small).* Pick one active non-English-review
     repo (the owner chooses; see Open questions). Fetch 6 months and
     label only the pooled rules from raw-mode runs, plus a 100-comment
     sample for the ceiling metric. No translation of the English set:
     translated text would test translation quality, not review culture.
- Manual: commander.js and swr in raw mode (whole set fits; plan 08).

## Docs & changelog

`docs/cli.md` (`candidates --raw`, flags, JSONL format), `docs/how-it-works.md`
("Extract" notes the plugin can bypass it; "Limitations": English-only
applies to the CLI only), README "What to expect", CHANGELOG `[Unreleased]`.

## Risks, compatibility & rollback

- **Context and cost.** 50–80k input tokens per run on busy repos, against
  ~16k today. It's opt-in or triggered, and the budget is printed. Users
  on small plans may notice.
- **Lower precision.** The model sees ~50% labelled negatives. The
  evidence bar and the show-before-write step still apply. Plan 13's
  rubric measures the effect.
- **Language-specific leaks.** English praise and resolution regexes don't
  catch other languages, so the raw set is noisier for non-English repos.
  This is acceptable: the model filters, and nothing is lost.
- Additive flag: `candidates` without `--raw` is byte-identical. Rollback
  means removing the flag and reverting the SKILL.md section.

## Cross-cutting checks

- **Credentials:** no change. The raw output passes through
  `secret-scan.redactText` before printing (plan 11). Bodies are verbatim
  user text and could contain pasted tokens.
- **Privacy:** raw mode sends more reviewer text to the model provider
  than `candidates` does (whole comments, not request sentences). The
  plan 11 data-handling statement must say so.
- **Determinism:** ordering is fixed for a given corpus. `now` comes from
  corpus metadata.
- **Deps:** none.
- **stdout/stderr:** JSONL on stdout, summary on stderr.
- **Windows:** no shell features. `path` uses `/` as stored by GitHub.
- **Plugin vs CLI:** raw mode exists only for model consumption. `run`
  and `generate` ignore it.

## Success metrics

- Comment-level ceiling stays ≥ 95% on dev and held-out.
- Pooled rule-level recall on vitest/pnpm/express rises by ≥ 1 kept rule
  per repo on average, with pooled precision no more than 10 points below
  `candidates` mode.
- On the non-English repo: ≥ 1 kept rule where `candidates` produces 0
  (if the repo has ≥ 2 active reviewers and ≥ 50 reviewed PRs).
- Busy repos fit the default budget: `dropped_for_budget = 0` on all
  three gallery repos.

## Open questions for the owner

1. Which non-English repo should be the multilingual test bed (e.g. a
   Japanese or Chinese OSS project with mostly native-language review)?
2. Should raw mode be the default when the whole set fits the budget
   (simpler skill), or only a fallback?
3. Resolved threads: keep dropping them, or keep them in raw mode as
   "acted on" evidence (Greptile's signal)? The heuristic CLI is
   unaffected either way.
4. Rule language for non-English repos: the user's chat language, or the
   reviewers' language?
