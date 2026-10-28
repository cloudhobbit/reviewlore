# vitest-dev/vitest

6 months of review history (Dec 2025 – Jun 2026), 6,154 comments.

## Plugin — 6 rules

| Rule | Support | Scope |
|---|---|---|
| [Add a test for every behaviour change or bug fix](./plugin/.claude/rules/pr-feedback-add-a-test-for-every-behaviour-change.md) | 10 PRs / 3 reviewers | `packages/**/*.ts` |
| [Write tests that fail without the change](./plugin/.claude/rules/pr-feedback-write-tests-that-fail-without-the-change.md) | 3 / 2 | `test/**/*.ts` |
| [Put tests in the existing suite for the area you changed](./plugin/.claude/rules/pr-feedback-put-tests-in-the-matching-test-suite.md) | 9 / 3 | `test/**/*.ts` |
| [Document new options and features in the same PR](./plugin/.claude/rules/pr-feedback-document-new-options-and-features.md) | 3 / 3 | `packages/**/*.ts` |
| [Keep internal-only options out of public TypeScript types](./plugin/.claude/rules/pr-feedback-keep-internal-options-out-of-public-types.md) | 3 / 2 | `packages/**/*.ts` |
| [Reuse what the codebase already has before adding a dependency or helper](./plugin/.claude/rules/pr-feedback-reuse-existing-dependencies-and-utilities.md) | 3 / 2 | `packages/**/*.ts` |

Below the bar (one reviewer only), so not written: "we don't accept PRs
to benchmarking at the moment", "use `toMatchInlineSnapshot`", "write AI
disclosures yourself". Dropped as review logistics: "resolve conflicts"
(10 PRs), "please fix CI".

## Heuristic — 3 rules

[`heuristic/.claude/rules/`](./heuristic/.claude/rules/): "add test
case" (7 PRs), "add a test to `test/ui`", and "resolve conflicts". The
first two are real but narrower versions of the plugin's test rules; the
third is review logistics the heuristic can't tell apart from a
convention.
