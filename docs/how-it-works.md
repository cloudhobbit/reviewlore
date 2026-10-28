# How it works

```
GitHub review history
  │  fetch: PR conversation comments, inline review comments, review bodies
  ▼
Filter          drop bots, plain-issue comments, PR authors' own replies,
                resolved threads, praise, very short comments
  ▼
Extract         split into sentences; keep the ones that ask for something
  ▼
Cluster         group sentences that share wording (never "do X" with "don't X")
  ▼
Synthesise      ┌ Claude Code plugin: Claude merges paraphrases, applies the
                │ evidence bar, shows you the rules, writes them   (recommended)
                └ CLI: heuristic rules from clusters that pass the thresholds,
                  optionally rewritten via the Claude API (--llm)
  ▼
.claude/rules/pr-feedback-*.md   scoped with `paths:` to the code the comments were on
```

## 1. Filter

Before anything is clustered:

- **Comments on plain issues** are dropped. GitHub's issue-comments
  endpoint returns them alongside PR conversation; they're bug reports
  and triage ("can you assign this to me?"), not review.
- **Bots** are dropped: GitHub `Bot` accounts plus a few that post as
  ordinary users (`codecov-commenter`, coveralls, sonarcloud).
- **AI reviewers on user accounts** are dropped when a review is signed
  ("powered by …", "🤖 … review" in its first lines) or reads as a
  generated report (bold "**Recommendation:**"-style labels together with
  severities).
- **PR authors' own comments** are dropped — explaining your change isn't
  reviewing it.
- **Resolved threads** are dropped when the PR author replies "fixed" /
  "done" / "good catch", or the reviewer withdraws the point
  ("nevermind", "disregard").
- **Praise and very short comments** ("LGTM", "thanks") are dropped.
- Feedback from a **changes-requested** review ranks higher (2×), approvals
  lower (0.5×). Weights order the results; they don't decide what's kept.

## 2. Extract

Each comment is cleaned (code blocks, quotes, images, URLs and @mentions
removed; `inline code` and link text kept) and split into sentences. A
sentence becomes a candidate only if it asks for something:

| Kind | Examples |
|---|---|
| prohibition | "don't …", "let's not …", "can't have …", "avoid …", "never …" |
| prescription | "we should …", "X should be …", "consider …", "can be removed", "Add a test for …" |
| request | "can you …", "could you …", "please …", "should we …" |
| question | "why not …", "is this necessary?" |

Precision beats recall here, so:

- Ambiguous words ("use", "prefer", "never", "always") only count at the
  start of a clause: "Just use X" counts, "we currently use three
  sources" doesn't.
- Hedges are ignored ("I don't know if …", "I don't think there are
  tests …") unless they carry a directive ("I don't think we should …").
- Status reports are ignored ("this should be fixed in the next
  release").
- Requests about the review itself are ignored ("please review", "assign
  it to me", "please see", "let me know").

## 3. Cluster

Candidates are grouped greedily by token overlap (Jaccard by default,
TF-IDF cosine with `--engine semantic`). Plurals are folded ("tests" →
"test"), prohibitions never share a cluster with prescriptions, and a
cluster's kind is the majority kind of its sentences. Identical input
gives identical output on any machine.

A cluster becomes a CLI rule when it has at least `--min-occurrences`
distinct (reviewer, PR) pairs (default 3) from at least `--min-authors`
reviewers (default 2).

## 4. Synthesise

Word overlap can't tell that "please add a changeset", "missing
changeset" and "this needs a changeset file" are the same request, and it
can't tell a convention from review logistics. That judgement is what the
Claude Code plugin adds:

1. The `learn-from-reviews` skill runs `reviewlore candidates`,
   which prints the strongest clusters (150 by default), single comments
   included, with quotes and links.
2. Claude merges clusters that ask for the same thing, drops logistics
   and one-off discussion, and keeps a rule only if its merged evidence
   spans at least 2 PRs and 2 reviewers.
3. It drops generic best practice, keeping only the repo-specific part
   (a path, a helper, a command), and checks each rule against the
   repo's existing instruction files, which `candidates` lists: rules
   already written down are skipped (or sharpened, if reviewers keep
   asking anyway), and conflicts are shown to you rather than written.
4. It writes each rule as an instruction, citing at least two verbatim
   quotes with links, and scopes it with `paths:`.
5. You see the proposed rules, with their status and context cost,
   before anything is written.

`candidates` also reports how much human review the window holds
(`history`). Under 50 PRs or 3 reviewers it flags the history as thin;
when one reviewer wrote 80 % or more of it, as single-reviewer. On the
gallery repos that flags swr (12 PRs) and commander.js (92 % from one
reviewer) — the two where no rule cleared the bar.

On vitest's history this produces 6 rules where the heuristic finds 3,
one of which is "resolve conflicts". See [`examples/real-repos/`](../examples/real-repos/).

The CLI's `--llm` flag is an API-key alternative for CI or other tools:
it rewrites each heuristic cluster with `claude-sonnet-5-5`, but only
sees clusters the heuristic already formed.

## 5. Scope

Claude Code reads one frontmatter field from a rule file, `paths`, and
loads the rule only when working on matching files. Globs come from where
the review comments were made: the top-level directory (or
`packages/<name>`) plus the extension, e.g. `packages/vitest/**/*.ts`.
Rules from comments that weren't on a file are unscoped and load in every
session.

## How good is it?

`npm run eval:real` scores extraction against 540 hand-labelled comments
from five public repos: does the pipeline pick up the comments a human
would call review requests, and only those? On the three repos held out
from tuning (express, commander.js, swr):

| | Precision | Recall |
|---|---|---|
| v0.2.2 | 18.9% | 28.0% |
| current | 72.7% | 64.0% |

CI fails if either drops below its floor. Details, labelling rubric and
known caveats: [`eval/real/README.md`](../eval/real/README.md).

The plugin's output is checked too, without a model: `npm run eval:skill`
verifies every gallery rule file against the `candidates` output it was
written from — each quote verbatim, author and PR matching the URL, at
least two PRs and two reviewers, sensible `paths` scoping
([`eval/skill/README.md`](../eval/skill/README.md)). It can't judge
whether a rule is *good*; that still takes a human (or a model) reading
the quotes.

## Limitations

- **Small or single-reviewer repos produce few or no rules.** The
  evidence bar needs two reviewers. That's deliberate: one person's
  preferences aren't necessarily the project's conventions.
- **Plain-English heuristics.** The phrase matcher only understands
  English. The plugin switches to raw mode (`candidates --raw`) for
  reviews in other languages, or when few comments match: Claude then
  reads whole comments, after the same language-agnostic filters. On the
  labelled set every review request survives those filters (60/60);
  how well rules come out of raw mode hasn't been measured yet.
- **AI reviewers posting from user accounts** are caught only when they
  sign their reviews or use report-style labels with severities (the
  detector is deliberately strict, so human comments aren't dropped).
  The plugin skill is also told to discount report-style reviews.
- **Rules quote reviewers by GitHub handle.** That keeps them
  checkable, but read generated rules before committing them, especially
  in a public repository.
