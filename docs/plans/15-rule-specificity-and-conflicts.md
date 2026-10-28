# 15 — Rule specificity, conflicts and minimum data

**Priority:** P1 · **Effort:** M (≈ 3–4 days) · **Depends on:** none (pairs with 10, 13)

## Problem

The skill can propose rules that cost context without changing behaviour
("Add a test for every behaviour change" — any engineer and any model
already knows that), rules that duplicate or contradict what the repo's
`CLAUDE.md` / `AGENTS.md` / hand-written rules already say, and — on repos
with little history — rules built on thin evidence. Users who see generic
or contradictory rules stop trusting the output, and research suggests
generic context files make agents slower and costlier without making them
better.

## Audit findings

- `skills/learn-from-reviews/SKILL.md` never reads the repo's existing
  instruction files. Its only interaction with existing files is "if
  `pr-feedback-<slug>.md` already exists, show the difference" and "leave
  hand-written rules alone" (step 4). No duplicate, contradiction or
  "already written but still flagged" check exists (grep for
  `CLAUDE.md|AGENTS.md|contradict|duplicate|generic` in SKILL.md: none).
- The skill's keep/drop list (step 2.2) filters logistics and one-offs but
  not *generic best practice*. Our own gallery shows the gap:
  `examples/real-repos/vitest/plugin/.claude/rules/pr-feedback-add-a-test-for-every-behaviour-change.md`
  is generic; its siblings ("put tests in `test/cli/dts`…", "use
  `runInlineTests`") carry the repo-specific part.
- `candidates` output has no measure of how much history was available.
  PRs in the window, from `meta.pr_authors` in the cached corpora:
  swr 54, commander.js 124, express 674, vitest 859, pnpm 969. Both repos
  under ~150 PRs produced 0 rules; one public write-up of a similar
  prompt-based approach reports results turning to noise below ~50 PRs
  (Rush, see sources).
- External evidence:
  - An ICLR 2026 study found repository context files generally did not
    improve agent task success and raised inference cost by >20%,
    recommending them only for non-standard practices
    ([arXiv 2602.11988](https://arxiv.org/abs/2602.11988)); a follow-up
    found no measurable correctness effect
    ([HF 2607.27250](https://huggingface.co/papers/2607.27250)).
  - Claude Code's memory docs: when instructions conflict, Claude may pick
    one arbitrarily; keep instructions specific and audit them
    periodically ([memory docs](https://code.claude.com/docs/en/memory)).
  - Rush's PR-mining skill labels each mined rule NEW / DUPLICATE /
    CONTRADICTS / VIOLATED against the existing rules file and reports
    VIOLATED (already written down, still flagged by reviewers) as the
    most valuable class ([Rush](https://rush.be/insights/mining-pr-comments-for-agent-review-rules)).

## Goals / Non-goals

**Goals**
- Every proposed rule carries a status against existing instructions:
  NEW, DUPLICATE, CONTRADICTS, or VIOLATED.
- Generic best practice is dropped unless the quotes add repo-specific
  detail, which then becomes the rule.
- The skill warns up front when the history is too thin, and says how
  confident the result can be.

**Non-goals**
- Editing the user's `CLAUDE.md` / `AGENTS.md`. The skill reports
  conflicts; the human resolves them.
- A deterministic "genericness" classifier in the CLI (judgement belongs
  to the model; the CLI supplies inputs).

## Options considered

1. **Prompt-only:** extend SKILL.md to read instruction files and label.
   Cheapest, but Claude must find the files itself and may miss nested
   ones.
2. **CLI supplies an inventory, skill judges (chosen):** `candidates`
   adds the list of existing instruction files (paths + sizes) and PR
   counts; SKILL.md reads them and labels. Deterministic discovery,
   model judgement.
3. **CLI computes duplicates by token overlap with existing rule text.**
   Cheap but misses paraphrase and contradiction — the same weakness that
   made the heuristic clusterer miss "changeset"; rejected as the primary
   mechanism.

## Design

### `candidates` additions (backwards-compatible fields)

```jsonc
{
  "history": { "prs": 969, "reviewers": 41, "top_reviewer_share": 0.38, "warning": null },
  "existing_instructions": [
    { "path": "CLAUDE.md", "bytes": 5141 },
    { "path": "AGENTS.md", "bytes": 1200 },
    { "path": ".claude/rules/testing.md", "bytes": 800, "generated": false },
    { "path": ".claude/rules/pr-feedback-add-a-changeset.md", "bytes": 900, "generated": true }
  ],
  …
}
```

- This `history` block is the single definition used by plans 08 and 12
  (empty-result diagnosis) — they must not add parallel fields.
- `history.prs` = PRs with at least one human review comment in the
  window; `history.reviewers` = distinct human reviewers;
  `history.top_reviewer_share` = share of human review comments from the
  most active reviewer (illustrative value above). `warning` is
  `"thin"` below 50 PRs or 3 reviewers and `"single-reviewer"` when one
  reviewer wrote ≥ 80% of human review comments (commander.js case).
- `existing_instructions`: `CLAUDE.md` / `AGENTS.md` / `REVIEW.md` at the
  root and in subdirectories (bounded walk, skip `node_modules`, `.git`,
  `vendor`, depth ≤ 4), `.claude/rules/**/*.md`,
  `.github/copilot-instructions.md`, `.github/instructions/*.instructions.md`.
  `generated` = file starts with our provenance comment.

### SKILL.md changes

1. **Before fetching:** nothing new.
2. **After reading candidates:** if `history.warning` is set, tell the
   user what it means before synthesising ("54 PRs with human review in
   6 months — expect few or no rules; consider `--months 12`").
3. **Specificity test (new step in 2):** for each candidate rule ask
   "would a competent engineer new to this repo already do this without
   being told?" If yes, keep only the repo-specific part (a path, a
   helper, a command, a named convention) or drop it. Examples in the
   skill text: generic "add tests" → specific "put CLI type tests in
   `test/cli/dts`".
4. **Reconcile (new step 3a):** read the files in
   `existing_instructions` (skip `generated: true` ones on a refresh —
   plan 10 owns those) and label each proposed rule:
   - NEW — not covered by any existing instruction;
   - DUPLICATE — an existing instruction already says it and reviewers
     only asked for it once or twice: don't write it; list it with the
     file that covers it;
   - VIOLATED — an existing instruction already says it, yet reviewers
     keep asking (the merged group meets the evidence bar): the written
     instruction isn't working — propose a sharper, path-scoped version
     next to it and say why;
   - CONTRADICTS — conflicts with an existing instruction: never write;
     show both texts and ask the user which is right.
5. **Proposal table** gains a Status column; DUPLICATE rows are listed
   under "not written" with the file that already covers them.

### Context budget

The skill reports the total bytes of rules it is about to add next to
the existing instruction bytes, and warns if unscoped (no `paths`) rules
exceed ~4 KB, pointing to the memory docs' guidance on keeping
always-loaded instructions short.

## Implementation steps

1. `lib/instructions.mjs` (new, pure): `findInstructionFiles(rootDir,
   { maxDepth })` → `[{ path, bytes, generated }]`; `historyStats(data)`
   → `{ prs, reviewers, top_reviewer_share, warning }` using the same human/PR filters as
   `applySignals` + `isNoise`.
2. `bin/reviewlore.mjs` `emitCandidates`: add `history` and
   `existing_instructions` (target dir = resolved target).
3. `skills/learn-from-reviews/SKILL.md`: steps above; keep the
   description line unchanged (context cost).
4. `docs/cli.md` (candidates schema), `docs/how-it-works.md`
   (synthesise section), CHANGELOG.
5. `scripts/check-pack.sh`: add `lib/instructions.mjs` to REQUIRED.
6. Re-run the gallery synthesis for vitest/pnpm/express and update
   `examples/real-repos/*` (expect the vitest "add a test for every
   behaviour change" rule to be dropped or folded into the specific
   one).

## Tests & verification

- `test/instructions.test.mjs`: discovery (nested files, depth limit,
  skip dirs, `generated` detection), history stats on fixtures including
  single-reviewer and thin cases.
- CLI test: `candidates` JSON contains `history` and
  `existing_instructions` for a fixture target with a `CLAUDE.md`.
- Skill: covered by plan 13's skill-output eval — add rubric items
  "no generic best practice", "status label present and correct" and two
  fixture cases (a CLAUDE.md that duplicates a mined rule; one that
  contradicts it).

## Docs & changelog

`docs/cli.md`, `docs/how-it-works.md` ("Synthesise" and "Limitations"),
README "What to expect" (thin-history warning), CHANGELOG `[Unreleased]`.

## Risks, compatibility & rollback

- New JSON fields are additive; older skills ignore them.
- Over-dropping: "generic" is a judgement; the skill must list dropped
  rules with reasons so users can ask to keep one.
- Reading instruction files adds context (bounded by listing sizes and
  reading only what's relevant); large monorepos with hundreds of
  `CLAUDE.md` files — cap the inventory at 50 entries, largest first.

## Cross-cutting checks

- No credentials touched; files read are repo files.
- Deterministic: inventory sorted by path.
- No new deps; `lib/` stays pure (fs reads are fine, no exits/prints).
- Windows: path separators normalised to `/` in output.

## Success metrics

- Skill-output eval (plan 13): ≥ 90% of written rules judged
  repo-specific; 0 written rules contradicting existing instructions.
- Gallery: vitest drops the generic rule; no new false drops on pnpm /
  express.

## Open questions for the owner

1. Thresholds for `warning: "thin"` (50 PRs / 3 reviewers) — keep the
   external figure or calibrate on more repos first?
2. Should DUPLICATE rules be silently dropped or always listed?
