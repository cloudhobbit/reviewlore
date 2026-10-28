# Real-repo examples

Unedited output from five public repositories, generated two ways:

- **`plugin/`** — the Claude Code plugin's `learn-from-reviews` skill:
  Claude reads `reviewlore candidates`, merges comments that ask
  for the same thing in different words, keeps only rules backed by
  ≥ 2 PRs and ≥ 2 reviewers, and writes path-scoped rules. Produced by
  following [`skills/learn-from-reviews/SKILL.md`](../../skills/learn-from-reviews/SKILL.md)
  with Claude Opus 5.5 (October 2026); a run in your session will word
  things differently.
- **`heuristic/`** — the CLI alone (`reviewlore run`, default
  thresholds), no model involved. Deterministic.

| Repo | Window | Comments | Plugin rules | Heuristic rules | Story |
|---|---|---|---|---|---|
| [vitest](./vitest/) | 6 mo | 6,154 | **6** | 3 | Rich review culture: test, docs and API conventions come through clearly. |
| [pnpm](./pnpm/) | 6 mo | 8,623 | **5** | 2 | Changesets, root-cause fixes, reuse — heuristic finds two of them, thinly. |
| [express](./express/) | 12 mo | 1,384 | **3** | 0 | Project-policy rules (no style-only PRs, keep core minimal). |
| [commander.js](./commander.js/) | 12 mo | 535 | 0 | 0 | One maintainer does nearly all review, so nothing clears the "≥ 2 reviewers" bar. |
| [swr](./swr/) | 6 mo | 170 | 0 | 0 | Too little human review to find any recurring convention. |

## How to read them

- Zero rules is a real result. The tool won't invent conventions from
  thin evidence; on small repos or single-reviewer repos you'll get few
  or none at the default bar.
- The rule files quote public review comments by GitHub handle, with
  links. That's what makes them checkable — and why you should read
  generated rules before committing them to your own repo.
- The heuristic column is what you get without Claude. It finds comments
  that share wording; it can't tell that "please add a changeset" and
  "missing changeset file" are the same request, and it can't tell review
  logistics ("resolve conflicts") from conventions.

- Support counts in each repo's README ("10 PRs / 3 reviewers") come
  from the `candidates` clusters a rule was merged from; each rule file
  cites a subset of them — at least two PRs and two reviewers.

## Reproducing

Corpora were fetched in May–June 2026. For any of the repos:

```bash
reviewlore fetch --owner vitest-dev --repo vitest --months 6 --cache
# heuristic/:
reviewlore generate ~/.reviewlore/vitest-dev__vitest.json --target ./heuristic
# plugin/: in a checkout of the repo, run /reviewlore:learn-from-reviews
```

## About the quotes

The rule files quote public pull-request review comments from the
repositories above, verbatim (as printed by `reviewlore candidates`), with
the reviewer's GitHub handle and a link to the original comment. They are
here to show what the tool produces. If you are quoted and would like a
quote removed, open an issue on this repository and it will be taken out.

