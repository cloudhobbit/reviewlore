# pnpm/pnpm

6 months of review history (Nov 2025 – May 2026), 8,623 comments.
Over 40% of all comments come from bot accounts — mostly AI reviewers
(Copilot, coderabbit) — and are filtered out.

## Plugin — 5 rules

| Rule | Support | Scope |
|---|---|---|
| [Add a changeset for every change that ships](./plugin/.claude/rules/pr-feedback-add-a-changeset.md) | 5 PRs / 3 reviewers | everywhere |
| [Reuse existing code instead of duplicating it](./plugin/.claude/rules/pr-feedback-reuse-code-instead-of-duplicating.md) | 4 / 2 | `**/*.ts` |
| [Fix bugs at their root cause](./plugin/.claude/rules/pr-feedback-fix-the-root-cause.md) | 4 / 2 | everywhere |
| [Cover every scenario with tests](./plugin/.claude/rules/pr-feedback-cover-every-scenario-with-tests.md) | 4 / 2 | everywhere |
| [Put logic in the module that owns it](./plugin/.claude/rules/pr-feedback-put-logic-in-the-module-that-owns-it.md) | 4 / 2 | `**/*.ts` |

Below the bar (one reviewer): "don't reformat files", "make new behaviour
opt-in rather than changing the default", "non-result output goes to
stderr".

## Heuristic — 2 rules

[`heuristic/.claude/rules/`](./heuristic/.claude/rules/): "don't
duplicate code" (3 PRs / 2 reviewers) and "fix … instead" (3 / 2) —
thinner versions of the plugin's reuse and root-cause rules, found
because a few comments share words (one quote is just "Please do this
instead:"). The changeset rule is invisible to it: the requests are
worded too differently to cluster.

Before v0.3 this repo produced 7 heuristic rules, all noise ("Could you
please assign it to me?", "I don't know if that's ok") — mostly because
comments on plain issues were treated as PR review.
