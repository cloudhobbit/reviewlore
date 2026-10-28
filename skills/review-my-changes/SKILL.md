---
name: review-my-changes
description: Before opening a pull request, check the current changes against this repository's PR review history and review-derived rules, and list what reviewers here have asked for on similar changes, with links.
when_to_use: "Use when the user says: review my changes against past reviews, what will reviewers say, pre-PR check, check before I open a PR, did I miss anything reviewers usually ask for, check against review history."
argument-hint: "[base branch]"
---

# Check changes against this repo's review history

You predict what this repository's reviewers are likely to ask for on the
current changes, using only their past review comments and the repo's
review-derived rules. You are not doing a general code review: every
finding must point at a rule file or a past review comment, and at the
place in the diff it applies to. If you can't do both, leave it out. An
empty result is a valid answer.

## 1. Get the precedents

Run this from the repository root. It is offline and reads no
credentials. If the user named a base branch, add `--base <branch>`;
otherwise it is detected from `origin`.

```bash
node "${CLAUDE_PLUGIN_ROOT}/cli/reviewlore.mjs" precedents
```

If the shell can't find `node`, tell the user that reviewlore needs
Node.js 20.11 or newer on their PATH, and stop.

The JSON has a `status`:

- `ok` — continue.
- `no-data` — no review history is fetched yet; only the repo's rule
  files were checked. Continue with `rules`, then tell the user that
  running `/reviewlore:learn-from-reviews` (or `reviewlore fetch --cache`)
  adds past review comments to this check.
- `no-base`, `not-a-repo`, `no-repo`, `git-error` — relay the `hint` and
  stop. Never fetch, and never look for credentials.

What it contains:

- `changed` — files changed since the merge base, including uncommitted
  and untracked ones (`status` A/M/D/R/U).
- `rules` — rule files from `.claude/rules/` whose `paths` match a changed
  file (`matched`), then rules with no `paths`, which apply to every PR
  (`unscoped: true`). `generated: true` means reviewlore wrote it from
  review history; others are hand-written.
- `recurring` — feedback that 2+ reviewers gave on 2+ PRs, about the
  changed files' areas (`scope`) or PR-wide (`scope: null`), with quotes.
- `file_history` — per changed file, the most relevant earlier review
  comments (`match`: same file, directory or package). This is context,
  not prediction: most past comments won't apply to this diff.

## 2. Judge each precedent against the diff

Read the diff for the files involved (`git diff <merge_base>` for
committed and uncommitted changes, and the files themselves for untracked
ones). Then:

1. **Each rule.** Read the rule file. Report it only if the diff does what
   the rule warns against, or leaves out what it requires — for example a
   rule asking for a changeset when `changed` has no `.changeset/` file, or
   a rule about tests when source files changed without a matching test.
   Label it **Rule** (or **Rule, hand-written** when `generated` is false).
2. **Each recurring item.** Apply the same test using its quotes. Label it
   **Recurring request** with its support (PRs / reviewers).
3. **File history.** Mention at most three comments, and only when a quote
   clearly concerns code this diff touches. Never present them as
   predictions.

Drop anything the diff doesn't actually trigger. Don't add findings from
general knowledge or style preferences — that is what `/code-review` is
for; mention it once at the end if the user wants a general review.

## 3. Report

Answer in chat; write no files. Use this shape:

```
Checked 5 changed files against reviewlore's history for owner/repo (cache, 3 days old).

Likely review comments
1. Rule: Add a changeset for every change that ships — no .changeset/ file in this diff.
   .claude/rules/pr-feedback-add-a-changeset.md · e.g. https://github.com/owner/repo/pull/123#issuecomment-1
2. Recurring request (3 PRs, 2 reviewers) — src/config.ts:42 adds an option without a test.
   "You probably should add tests for this." (@alice, #101 <url>) · "Can we have a test for this?" (@bob, #117 <url>)

Earlier comments on these files (context)
- src/config.ts — "Keep option names kebab-case." (@alice, #96 <url>)

Nothing found for: 3 files.
```

- Quote reviewers exactly as the JSON gives them, with their handles and
  links.
- Point each finding at a file (and line, when you can) in the diff.
- If nothing applies, say: "Nothing in this repo's review history applies
  to these changes." Then stop.
- Offer to fix a finding only if the user asks. Never edit files, commit,
  push or block anything as part of this check.
