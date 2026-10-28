# 09 — "Review my changes" skill: check a diff against review history

**Priority:** P1 · **Effort:** M–L (≈ 5–6 days, estimate) · **Depends on:** 06 (index module, repo resolution); uses 10's provenance when present; complements 15

_Status (October 2026): implemented. Changes from this design: the skill
runs `precedents` as an ordinary command rather than `` !`…` `` injection
(a failing injected command aborts the skill, and `precedents` reports
problems as a JSON `status` with exit 0 instead); the glob matcher is
the shared `lib/globs.mjs`; `recurring` also lists PR-wide clusters
(`scope: null`) after area ones. The leave-one-PR-out evaluation and the
hand-labelled precision check are still to do._

## Problem

After generating rules once, developers have no reason to come back. The
moment the history is most useful is just before opening a PR: "what will
reviewers in this repo ask me to fix?" Today Claude can't answer that from
the review history. Path-scoped rules load only when a matching file is
read or edited. Nothing compares a diff with past feedback, and the MCP
server needs owner/repo and has no notion of a diff.

## Audit findings

- `skills/` has one skill, `learn-from-reviews/SKILL.md` (153 lines). It
  runs `node "${CLAUDE_PLUGIN_ROOT}/bin/reviewlore.mjs" candidates`
  (line 29) and has no diff or base-branch logic.
- `lib/mcp-tools.mjs:84-109` `recentFeedback` matches by path prefix only.
  It has no ranking, no thread collapse and no rule matching (see plan 06).
- `lib/extract.mjs:23-60` candidates keep `path`, `kind`, `url`, `pr`,
  `author` and `createdAt`, which is everything a precedent needs.
  `buildClusters` (line 74) gives `paths`, `distinctPRs` and
  `distinctAuthors` per cluster.
- `lib/renderers/_common.mjs:66-81` `pathGlobs` maps paths to
  `<top>/**/*.ext` or, under package dirs, `packages/<name>/**/*.ext`. It
  falls back to `**/*.ext` above 5 globs. There is **no glob matcher** in
  the repo (grep for `matchesGlob|minimatch`: none). Node's
  `path.matchesGlob` doesn't exist on our `engines` floor (`>=20.11`), so
  matching rule `paths` against changed files needs a small hand-rolled
  matcher.
- `lib/git-info.mjs` has `findGitToplevel` and `detectRepoFromGit`. It has
  no base-branch or diff helpers.
- The corpus has **no changed-file lists per PR**, only paths that received
  inline comments, so "files changed together" can't be learned today.

**Measured: do path precedents predict the next review?** For each PR in
the last 60 days of each cached corpus that received human inline
comments, I looked only at earlier comments on other PRs:

| corpus | eval PRs | commented paths | same-file precedent | same-dir | same package scope | median prior in scope | actual comments with a similar prior in scope* |
|---|---|---|---|---|---|---|---|
| pnpm | 31 | 46 | 2 | 16 | 42 | 11 | 1 / 74 |
| vitest | 62 | 125 | 42 | 89 | 120 | 119 | 16 / 219 |
| express | 6 | 6 | 4 | 6 | 5 | 12 | 0 / 10 |

\* Token Jaccard ≥ 0.25 between the actual comment and any earlier comment
in the same `pathGlobs` scope. This is a lexical lower bound, because
paraphrases are missed.

Conclusions:

- Package-scope precedents are almost always present but plentiful (median
  11–119), so listing them unranked is noise.
- Same-file precedent is rare on pnpm (2 of 46).
- Raw file history alone predicts a lexically similar comment for only 1–7%
  of real comments. The skill must lead with **recurring conventions**
  (rules and multi-reviewer clusters) and treat file history as context,
  not as predictions.

Docs (verified 2026-10-27):

- Skills: `description` + `when_to_use` are truncated at 1,536 characters.
  `` !`cmd` `` injects command output before Claude sees the skill, and a
  failing command aborts the invocation. `context: fork` runs the skill in
  a subagent (https://code.claude.com/docs/en/skills).
- Claude Code Review reads `REVIEW.md` and `CLAUDE.md` on the PR and flags
  when a PR makes a CLAUDE.md instruction outdated
  (https://code.claude.com/docs/en/code-review). That is server-side and
  after the PR is opened. Ours is local, before the PR, and grounded in this
  repo's human review history. We position it as a complement.
- Rush's PR-mining skill found **VIOLATED** the most valuable label: a rule
  already written down that reviewers still flag
  (https://rush.be/insights/mining-pr-comments-for-agent-review-rules).
  A pre-PR check is where VIOLATED becomes actionable for one diff.

## Goals / Non-goals

Goals: one command ("check my changes against review history") that
reports likely review comments on the current diff, each with a precedent
link and the diff location. It is deterministic about *which* history
applies (CLI) and uses Claude's judgement only for *whether* the diff
triggers it. It never invents issues.

Non-goals: general code review (bugs, style) — that's `/code-review` and
Claude Code Review. Also out of scope: posting to GitHub, blocking commits
or pushes (no hooks, no non-zero exit for findings), and network access.

## Options considered

1. **Skill only, through MCP tools.** Claude calls `review_feedback_for_path`
   per changed file. This needs MCP (absent for npm-only users), costs one
   call per file, and ranking/selection is spread across many tool results.
2. **CLI subcommand `precedents` plus a skill (chosen).** The CLI computes
   changed paths, matching rules and recurring clusters deterministically
   in one JSON. The skill injects it with `` !`…` `` and does the judgement.
   It is testable, reusable without the plugin
   (`reviewlore precedents`), and gives one stable input.
3. **Fully heuristic CLI verdicts** (match diff text to rule keywords).
   Brittle and likely to invent issues. It fails the precision bar.

## Design

### CLI: `reviewlore precedents`

```
reviewlore precedents [--base <ref>] [--paths a,b,…] [--limit 8]
                               [--months 12] [--owner o --repo r]
```

- **Changed paths:** if `--paths` is given, use it as-is. Otherwise compute
  them with local git only (never `git fetch`):
  - base = `--base`, then `git symbolic-ref --short refs/remotes/origin/HEAD`,
    then the first of `origin/main`, `origin/master`, `main`, `master` that
    resolves;
  - `mb = git merge-base HEAD <base>`;
  - changed = `git diff --name-only -M <mb>` (working tree vs merge base,
    so it includes staged and unstaged changes), plus
    `git ls-files --others --exclude-standard`.
  - Renames report the new path. Deleted files are kept, marked `deleted`.
  - If there is no base, exit 1 with the stderr message "Couldn't find a
    base branch; pass --base <ref>".
- **Data:** same resolution as plan 06 (`resolveContext`), then
  `buildIndex` from `lib/review-index.mjs`. With no data, exit 0 with
  `{status: "no-data", hint}` so the skill's `` !`…` `` doesn't abort.
- **Output** (stdout JSON, deterministic, one item per line like
  `candidates`):

```jsonc
{
  "repo": "pnpm/pnpm", "base": "origin/main", "merge_base": "abc123",
  "data": { "source": "corpus", "age_days": 12, "since": "…" },
  "changed": [{ "path": "config/config/src/index.ts", "status": "M" }],
  "rules": [{                      // rule files whose paths globs match ≥1 changed file
    "file": ".claude/rules/pr-feedback-add-a-changeset.md", "title": "…",
    "generated": true, "matched": ["config/config/src/index.ts"],
    "unscoped": false, "evidence_urls": ["…", "…"]
  }],
  "recurring": [{                  // clusters with ≥2 PRs AND ≥2 reviewers whose paths overlap changed scopes
    "kind": "request", "prs": 3, "reviewers": 2, "scope": "config/**/*.ts",
    "quotes": [{ "text": "…", "author": "…", "pr": 1, "url": "…", "path": "…" }]
  }],
  "file_history": [{               // per changed file: top N ranked comments (plan 06 ranking)
    "path": "…", "same_file": 2, "same_scope": 11,
    "comments": [{ "quote": "…", "url": "…", "author": "…", "pr": 1, "kind": "request", "match": "file" }]
  }],
  "stats": { "changed": 5, "rules_matched": 2, "recurring": 1, "files_with_history": 3 }
}
```

- **Glob matcher** `lib/glob.mjs`: supports `**`, `*`, `?`, `{a,b}` and
  `[...]`, and is POSIX-path only. That covers what Claude Code's `paths`
  accepts and what `pathGlobs` emits. Unscoped rules (no `paths`) are
  listed with `unscoped: true` and `matched: []`. They apply to the PR as
  a whole (changesets, changelog).
- `limit` caps `file_history.comments` per file (default 3) and `recurring`
  (default 8). The whole output targets under 25 KB.

### Skill: `skills/review-my-changes/SKILL.md`

Frontmatter:

```yaml
name: review-my-changes
description: Before opening a pull request, check the current changes against this repository's PR review history and its review-derived rules, and list the review comments reviewers here have made on similar changes, with links.
when_to_use: "Use when the user says: review my changes against past reviews, what will reviewers say, pre-PR check, check before I open a PR, did I miss anything reviewers usually ask for, check against review history."
argument-hint: "[base branch]"
```

Body outline:

1. **Context injection:** run
   ``!`node "${CLAUDE_PLUGIN_ROOT}/bin/reviewlore.mjs" precedents --base "$ARGUMENTS" 2>&1 || true` ``
   with an empty `$ARGUMENTS` meaning auto-detect. Also run
   `` !`git diff --stat …` ``. Claude reads the full diff itself with the
   Bash tool, scoped to matched files.
2. **For each `rules[]` entry:** read the rule file and the matching hunks.
   Report it only if the diff plausibly does what the rule warns against,
   or omits what it requires (for example, an unscoped "add a changeset"
   rule with no `.changeset/*.md` in `changed`). Label it **VIOLATED?**
   with the rule path and one evidence URL.
3. **For each `recurring[]` entry:** the same test against the hunks. Label
   it **Recurring request** with support (PRs/reviewers) and two quote
   links.
4. **`file_history[]`:** don't present it as predicted comments. Mention at
   most 3 items as "Reviewers previously said about this file", and only
   when a quote clearly concerns code the diff touches.
5. **Output format**, in chat and with no files written:

```
Checked 5 changed files against 214 PRs of review history (corpus, 12 days old).

Likely review comments
1. VIOLATED? Add a changeset for every change that ships — no .changeset/ file in this diff.
   Rule: .claude/rules/pr-feedback-add-a-changeset.md · e.g. "Please add changesets" (@zkochan, #10246 <url>)
2. Recurring request (3 PRs, 2 reviewers) — config/config/src/index.ts:42 adds an option without a test.
   "You probably should add tests for this." (#10954 <url>) · "Can we have a test that verifies this?" (#11087 <url>)

Context (not predictions)
- config/config/src/index.ts — 2 earlier comments; latest: "…" (<url>)

Nothing found for: 3 files (no matching rules or recurring feedback).
```

Guardrails, written in the skill:

- Every finding cites a rule file or a URL from the `precedents` output and
  a diff location. If it can't, drop it.
- Don't add findings from general knowledge. That is `/code-review`'s job;
  mention it once in a line.
- Never edit files, commit or block. Offer fixes only when asked.
- Quote reviewers verbatim, with handles as printed. Don't paste the output
  into PR descriptions unless the user asks.
- With `status: "no-data"`, explain the options (run `learn-from-reviews`,
  or ask a teammate for `publish-corpus`) and stop. Never look for
  credentials.
- When nothing matches, say so plainly. "No precedents" is a valid result.

### Composition with existing rules

- Rules that are path-scoped already load when Claude edits those files.
  This skill covers what loading can't: PR-level rules (changesets, docs),
  files changed by hand outside Claude, and **VIOLATED** detection after
  the fact.
- Hand-written rules matched by globs are shown with `generated: false`.
  The skill may cite them but never proposes edits to them. Plan 15 owns
  the generation-time duplicate/contradiction labels, and plan 10 owns
  refresh. Repeated VIOLATED findings here are a signal for plan 10's
  "sharpen" proposal.

## Implementation steps

1. `lib/git-info.mjs`: add `detectBaseRef(cwd, explicit)` and
   `changedPaths(cwd, base)` (spawnSync, timeouts, best-effort).
2. `lib/glob.mjs` (new): `globToRegExp`, `matchesAny`.
3. `lib/review-index.mjs` (from plan 06): add `precedentsFor(index,
   changed, {limit, months})`.
4. `bin/reviewlore.mjs`: `precedents` subcommand, HELP text, flag
   validation. The emitter writes one item per line.
5. `skills/review-my-changes/SKILL.md` (new).
6. `scripts/check-pack.sh`: add `lib/glob.mjs`. Tests (below).
7. Docs and changelog.

## Tests & verification

- `test/glob.test.mjs`: table tests for each `pathGlobs` output shape,
  braces, `**` at start, middle and end, and root files.
- `test/git-info.test.mjs`: temp repo (`git init`, commits on `main`, a
  feature branch with modified, renamed, deleted and untracked files),
  base auto-detection order, and a missing base. Local git only.
- `test/cli.test.mjs`: `precedents --paths …` against a fixture corpus and
  rule files gives byte-identical JSON across two runs; `no-data` exits 0.
- Eval (manual, cached corpora): replay the leave-one-PR-out table above
  with `precedents`. Report, per PR, whether any of its actual human
  comments matches a `rules`/`recurring` item (a precision/recall proxy).
  Hand-label 20 skill outputs on vitest for "would a maintainer agree this
  comment is likely?". The target precision is ≥ 70%.

## Docs & changelog

`README.md` (plugin section: the second skill, one example), `docs/cli.md`
(`precedents` reference), `docs/how-it-works.md` (what counts as a
precedent), `CHANGELOG.md [Unreleased]` → Added.

## Risks, compatibility & rollback

- Noise is the main risk. Mitigations: rules and recurring items lead, file
  history is capped and labelled as context, and the skill has explicit
  drop rules. Rollback means deleting the skill directory. The CLI
  subcommand is additive.
- Shallow clones (CI, some IDEs) may lack the merge base. In that case,
  report it and fall back to `git diff --name-only HEAD` plus untracked
  files, with a warning.
- The `!` injection is disabled under `disableSkillShellExecution`. The
  skill then tells Claude to run the same command through Bash.
- Unverified: whether `$ARGUMENTS` is substituted before a `` !`…` ``
  command runs. If it isn't, or for safety (shell metacharacters in user
  arguments), inject `precedents` with auto-detection only. The skill then
  re-runs it through Bash with `--base <ref>` when the user named a branch.
  `precedents` treats an empty `--base` as auto and validates refs with
  `git rev-parse --verify`.

## Cross-cutting checks

- **Credentials:** none. `precedents` never builds a GitHub client.
- **Privacy:** output quotes handles already in the corpus and is shown
  only in chat. Nothing is written.
- **Determinism:** sorted changed paths and stable ranking. Git output is
  parsed with `-z` where filenames may contain spaces.
- **Dependencies:** none.
- **stdout/stderr:** JSON goes to stdout, git warnings to stderr.
- **Windows:** git returns `/` paths. The glob matcher is POSIX, and
  `${CLAUDE_PLUGIN_ROOT}` quoting follows the docs.
- **Plugin vs CLI:** the CLI works standalone. The skill needs the plugin.

## Success metrics

- On the hand-labelled vitest sample: ≥ 70% of reported items judged
  plausible. Zero items without a URL or rule citation (lint check on
  output).
- `precedents` under 300 ms on pnpm, cold.
- Adoption: a skill invocation rate per active user is not measurable
  locally. Proxy: issues and feedback. Open question below.

## Open questions for the owner

1. Name: `review-my-changes` or `check-against-reviews`? The slash command
   becomes `/reviewlore:<name>`.
2. Should the skill run in `context: fork`, which keeps the main context
   clean but hides the reasoning?
3. Should we later persist per-PR changed-file lists in the corpus (one more
   API call per PR) to learn "files changed together" precedents?
