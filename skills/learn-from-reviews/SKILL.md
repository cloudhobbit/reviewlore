---
name: learn-from-reviews
description: Turn this repository's pull-request review history into path-scoped Claude Code rules (.claude/rules/pr-feedback-*.md). Use when the user wants to learn the team's conventions from PR review comments, generate rules from recurring reviewer feedback, or refresh rules generated earlier by reviewlore.
argument-hint: "[months of history (default 6) | demo | single-maintainer]"
---

# Learn conventions from PR review history

You turn what reviewers keep asking for in this repo's pull requests into
rules Claude Code loads when editing the matching files. The toolkit does
the fetching and filtering; you do the judgement: merging comments that
ask for the same thing in different words, and dropping anything that is
not a convention.

Precision matters more than coverage. A wrong rule is loaded into every
future session in this repo, so when in doubt, leave it out.

## Demo mode

If the argument is `demo` (or the user asks to try it out on sample
data), skip step 0 and use this instead of the step 1 command — it needs
no repository, token or network:

```bash
node "${CLAUDE_PLUGIN_ROOT}/cli/reviewlore.mjs" candidates --demo --save
```

Then do steps 2 and 3 as usual on the file it prints. The data is
vitest-dev/vitest's public review history with reviewer names replaced
by pseudonyms. **Write no rule files in demo mode**, even if the user
approves the table: end with "This was a demo on vitest's public review
history; nothing was written. Run `/learn-from-reviews` in your own
repository to do it for real." and delete the temporary file as in
step 5. If `node` isn't found, give the Node message from step 0.

## 0. Check the setup

Run this from the repository root. It is offline and reads no
credentials:

```bash
node "${CLAUDE_PLUGIN_ROOT}/cli/reviewlore.mjs" doctor
```

- **The shell can't find `node`** ("command not found", "not
  recognized") — tell the user: "reviewlore needs Node.js 20.11 or newer
  on your PATH, and Claude Code doesn't include it. Install Node.js LTS
  from https://nodejs.org (or `brew install node`, or
  `winget install OpenJS.NodeJS.LTS`), restart Claude Code, then run this
  again." Stop.
- **Any `FAIL` line** — relay its message and `fix:` text in plain words
  and stop. Don't work around it (no installing packages, no other
  repository). For missing dependencies, add: "Claude Code installs the
  plugin's npm dependencies when the plugin is installed, so npm must be
  on your PATH. Run `/plugin`, check the note on reviewlore, then
  reinstall it."
- **`warn` lines** — mention them only if they matter later (a `corpus`
  warning means the history will be fetched from GitHub instead).

## 1. Get the review feedback

If the user gave a lookback, add `--months <n>` to both commands below;
otherwise leave the default (6).

**If `doctor` reported no usable committed corpus**, the PR history comes
from GitHub, using the user's `GITHUB_TOKEN` or `gh` login. Say so in one
line, then fetch it into reviewlore's local cache in steps of at most 90
seconds:

```bash
node "${CLAUDE_PLUGIN_ROOT}/cli/reviewlore.mjs" fetch --cache --no-output --time-budget 90
```

- Exit code **0**: done (a repo fetched before only tops up what's new).
- Exit code **75**: it stopped at the time budget and saved its
  progress. Tell the user the `Partial: …%` line, then run the same
  command again — each run resumes. Stop after 15 runs and report.
- If Claude Code moves the command to the background, wait for it to
  finish and read its output; never start a second fetch of the same
  repo while one is running.
- Any other failure: see "If a command fails" below.

Then, in every case:

```bash
node "${CLAUDE_PLUGIN_ROOT}/cli/reviewlore.mjs" candidates --save
```

It writes the feedback to a private temporary file and prints only that
file's path.

Read that file — one cluster per line, so read it in chunks of a few
hundred lines if it is large. Progress goes to stderr; the file holds
JSON:

- `stats` — comments fetched, candidate sentences, clusters, clusters shown.
- `history` — `prs` and `reviewers` with human review comments in the
  window, `top_reviewer_share`, and `warning`: `"thin"` (under 50 PRs or
  3 reviewers) or `"single-reviewer"` (one person wrote ≥ 80 % of the
  feedback).
- `existing_instructions` — the repo's instruction files (`CLAUDE.md`,
  `AGENTS.md`, `REVIEW.md`, `.claude/rules/**`, Copilot instructions)
  with sizes; `generated: true` marks rules this skill wrote before.
- `clusters[]` — groups of similar reviewer sentences, strongest first
  (weighted by review state). Each has `kind` (request / prescription /
  prohibition / question), `occurrences`, `reviewers`, `prs`, `globs`
  (where the comments were made), and up to five `quotes` with `author`,
  `pr`, `url`. Many clusters are singletons; that is expected — the tool
  groups by shared words only, so paraphrases land in separate clusters.

Only the first `--limit` clusters (default 150) are printed. If the last
printed cluster still has `prs` ≥ 2, more recurring feedback was cut off:
re-run it with `--save --limit 400` (no new fetch; it reads the cache)
and discard the first file as in step 5.

### Raw mode: whole comments, any language

`candidates` only keeps sentences that match English request phrasing.
Switch to raw mode — whole human review comments, already filtered for
bots, AI reviews, PR authors and resolved threads — when:

- the user asks ("use all comments", "our reviews are in German");
- `stats.candidates` is under 20 while `history.comments` is over 50
  (reviewers here don't phrase requests the way the matcher expects); or
- `history.comments` is 300 or fewer, so the whole set is small enough to
  read.

Tell the user in one line which mode you're using and why. Then run,
with the same `--months` as before:

```bash
node "${CLAUDE_PLUGIN_ROOT}/cli/reviewlore.mjs" candidates --raw --save
```

The file's first line is a header (`stats`, `history`, `url_base`); each
further line is one comment: `u` (link suffix: the comment's URL is
`url_base` + `u`), `by`, `pr`, `k` (comment / inline / review), `state`,
`path`, `at`, `text`. Read it in chunks of about 300 lines. Note
conventions as you go, with the `u`, author and PR of each comment
supporting them, then synthesise exactly as in step 2 — the same evidence
bar. In raw mode:

- Ignore praise, status updates ("Released in v15"), questions without a
  requested change and logistics, in any language.
- Quote the shortest sentence (or phrase, for languages without sentence
  punctuation) that states the request, verbatim in its original
  language. Write the rule itself in the language the user is chatting
  in, unless they ask otherwise.
- If `stats.dropped_for_budget` is above 0, say so and offer
  `--budget <tokens>` to include more.
- Delete this file too at wrap-up (step 5).

If a command fails:

- **No GitHub token** ("No GitHub token found" or "No token for
  <host>") — tell the user the options and stop: run `gh auth login`
  (for a GitHub Enterprise host: `gh auth login --hostname <host>`, or
  set `GH_ENTERPRISE_TOKEN`), export `GITHUB_TOKEN`, or ask a teammate to
  run `reviewlore publish-corpus` and commit the corpus file. For a GitLab
  repository, the user exports `GITLAB_TOKEN` (a personal access token with
  the `read_api` scope), plus `GITLAB_HOST=<host>` for a self-managed
  GitLab. Never look for, read, or print credentials yourself.
- **Missing dependencies** (`Cannot find package` or "needs reviewlore's
  npm dependencies") — relay the message's fix (reinstall the plugin with
  npm on PATH), then stop.
- **Rate limited** ("Hit GitHub's … rate limit; it resets at …") —
  report the reset time and stop; progress is saved, so re-running then
  continues where it left off. Another 403 means the token can't read
  the repository: report it.

## 2. Synthesise rules

**If `history.warning` is set, say so before anything else**, in one or
two sentences with the numbers — e.g. "Only 12 PRs had human review in
the last 6 months, so expect few or no rules; `--months 12` may help" or
"One reviewer wrote 92 % of the feedback, so few conventions will clear
the two-reviewer bar." Then continue.

Work from the quotes, not the labels.

1. **Group by meaning.** Merge clusters whose quotes ask for the same
   change ("add a changeset" / "please include a changeset file" /
   "missing changeset"). A merged group's support is roughly the sum of
   its clusters' `prs` and `reviewers` (quotes are capped at five per
   cluster, so you can't count exactly).
2. **Keep only conventions.** Keep guidance someone could apply while
   writing code or opening a PR in this repo: code style and API design,
   testing expectations, docs / changelog / changeset requirements,
   naming, architecture boundaries. Drop:
   - review logistics (assign me, please review, rebase, resolve
     conflicts, merge timing, CI re-runs);
   - discussion of one specific bug or design that won't recur;
   - opinions without a requested action;
   - anything only one reviewer ever said, unless the user asks for that.
3. **Apply the evidence bar.** A rule needs **at least 2 distinct PRs
   and at least 2 distinct reviewers** — and the quotes you will cite
   must show that on their own, so anyone can check it from the rule
   file. If the user explicitly asks for looser thresholds, say which
   rules fall below the default bar.

   **Single-maintainer mode** (the argument is `single-maintainer`, or
   the user asks for it after the diagnosis below): a group from **one**
   reviewer also qualifies if it spans **at least 3 distinct PRs**. Such a
   rule is labelled, so nobody mistakes it for a team convention:
   - title starts with `Maintainer preference: `;
   - right after the rule text, the line
     `**Support:** one reviewer (@handle) on N PRs — below the team bar of 2 reviewers. Review before relying on it.`
   A rule that does reach 2 reviewers is a normal rule, unlabelled.

   With a long window (12 months or more), drop a group whose newest
   quote is over 18 months old unless the user wants to keep it: the
   convention may have changed since.
4. **Write the rule, don't invent it.** State it as a specific,
   imperative instruction ("Add a changeset for every user-facing
   change"). Every claim in the rule and its reason must be traceable to
   the quotes. Do not add details, library names or rationale the quotes
   don't support. If you can't state one clear rule from a group, drop it.
5. **Scope it to where it must be remembered.** Start from the union of
   the group's `globs`, broadened to their common parent
   (`packages/**/*.ts`) when the quotes describe a general convention
   rather than one file's quirk. A rule that is triggered by changing
   code but asks for edits elsewhere ("document new options", "add a
   changeset") must be scoped to that code or left unscoped — never to
   the docs or changeset files, where it would load too late. Rules about
   the PR as a whole have no `paths` and apply everywhere.
6. **Watch for AI-written reviews.** Comments that read like a generated
   report (bold "**Recommendation:**" headings, severity labels, long
   bullet lists of "Consider …") are often an AI reviewer posting from an
   ordinary account. Don't count them as reviewer support.
7. **Keep only what's specific to this repo.** Ask of each rule: would a
   competent engineer new to *this* repo already do this without being
   told? If so, keep only the repo-specific part — a path, a helper, a
   command, a named convention — or drop the rule. "Add tests for
   behaviour changes" is generic; "Put CLI type tests in `test/cli/dts`"
   is a convention. Generic rules cost context in every session and
   change nothing.
8. **Check against what's already written.** Read the files in
   `existing_instructions` that could cover the rule (skip
   `generated: true` ones — those are this skill's own earlier rules,
   handled in step 4). Give each rule a status:
   - **NEW** — nothing existing says it.
   - **DUPLICATE** — an existing instruction already says it. Don't write
     it; list it with the file that covers it.
   - **VIOLATED** — an existing instruction says it, yet reviewers keep
     asking (the group meets the evidence bar). The written instruction
     isn't working: propose a sharper, path-scoped rule and say which
     file it reinforces.
   - **CONTRADICTS** — it conflicts with an existing instruction. Never
     write it: show both texts and ask the user which is right.

**If nothing reaches the bar**, use `candidates`' `diagnosis` (present
when no word-matched group got there; you may still have found one by
merging paraphrases): give its `reasons` in the user's terms, with the
numbers, then offer its `suggestions` in order — for example, single-
maintainer mode for a one-reviewer repo, or a longer window (re-run step
1 with `--months`). Say plainly that zero can be the right answer. Never
loosen the bar without the user choosing one of these, and stop there.

## 3. Show the user before writing anything

Present a table: rule title, status (NEW / VIOLATED), support (PRs /
reviewers), scope (paths or "everywhere"), and the file it will be
written to. Below it, list DUPLICATE rules with the file that already
covers them, CONTRADICTS rules with both texts, and what you dropped and
why — one line each, or a summary if there are many (generic best
practice, logistics, one-offs, below the bar).

Add one line on context cost: the bytes the new rules add next to the
existing instruction files' total from `existing_instructions`. If rules
with no `paths` (loaded in every session) add up to more than about 4 KB,
say so and suggest scoping or trimming them.

Ask the user to confirm, edit or remove rules. Do not write files until
they answer.

## 4. Write the rules

One file per rule at `.claude/rules/pr-feedback-<slug>.md`, where
`<slug>` is a short kebab-case form of the title. Keep the `pr-feedback-`
prefix: it is how users find and bulk-delete generated rules.

```markdown
---
paths:
  - "src/api/**/*.ts"
---
<!-- Generated by reviewlore (learn-from-reviews) from PR review history. Review, edit or delete freely. -->

# Add a changeset for every user-facing change

Every PR that changes user-visible behaviour includes a changeset in
`.changeset/` describing the change.

**Why:** Reviewers requested it on 6 PRs (4 reviewers); releases and the
changelog are generated from changesets.

## Examples from PR review history

- > Please add a changeset
  — @reviewer on PR #123: https://github.com/owner/repo/pull/123#issuecomment-1
- > This needs a changeset since it changes the CLI output.
  — @other on PR #140: https://github.com/owner/repo/pull/140#discussion_r2
```

- Omit the whole frontmatter block when the rule has no `paths`. Claude
  Code reads no other frontmatter field, so don't add any.
- Quote reviewers exactly as `candidates` printed them (it has already
  removed URLs, @mentions and code blocks): at least two quotes, from at
  least two PRs and two reviewers, each with its URL.
- If `pr-feedback-<slug>.md` already exists, show the difference and ask
  before replacing it. Leave hand-written rules (no `pr-feedback-` prefix)
  alone.

Then record each file you wrote, with the words a search should use to
find more of the same feedback (the convention's own terms, e.g.
`changeset`, not the whole title). This tracks the rule in
`.claude/reviewlore-rules.json` so later refreshes can check it:

```bash
node "${CLAUDE_PLUGIN_ROOT}/cli/reviewlore.mjs" rules record pr-feedback-add-a-changeset.md --query "changeset"
```

## Refreshing rules written earlier

If `.claude/reviewlore-rules.json` exists, or the user asks to refresh or
update their review rules, run this alongside step 1:

```bash
node "${CLAUDE_PLUGIN_ROOT}/cli/reviewlore.mjs" rules status --json
```

For each rule it reports `suggest` and `flags`; `recent_support` counts
are word-matched and approximate, so read the quotes before deciding.
Classify every existing rule and present them in the step 3 table with a
Status column:

- **KEEP** — still asked for, or quotes have aged out with nothing
  contradicting them. Age alone is never a reason to retire a rule.
- **UPDATE** — `paths-partial`, or `update` (aged-out quotes but recent
  support): propose fresher quotes from `candidates` or `recent_support`
  links, or adjusted `paths`, as a diff. If the file is `edited`, change
  only its Examples section, and only with the user's OK.
- **RETIRE** (proposal) — `paths-gone`, or contradictions you've read and
  confirmed (2+ reviewers, newer than the rule's evidence). On approval,
  delete the file, then run `rules retire <file>`.
- **Deleted by the user** (`missing`) — confirm, then run
  `rules dismiss <file>`; don't recreate it.
- **Not tracked** (`unmanaged`) — written before tracking existed; offer
  to run `rules record <file>`.

New groups from step 2 are **ADD**, as before. Skip any whose title or
evidence matches an entry in the manifest's `dismissed` list unless its
support has at least doubled — then say "you removed this on <date>".
When the user declines a proposed rule, remember it:
`rules dismiss --title "<title>" --urls <url>,<url>`.

Show the table, then the diff of every change, and write only what the
user approves. Run `rules record` for each file you add or update.

## 5. Wrap up

Delete the temporary file from step 1 — it holds reviewers' comments:

```bash
node "${CLAUDE_PLUGIN_ROOT}/cli/reviewlore.mjs" candidates --discard "<path step 1 printed>"
```

Then list the files written.

If the repository also uses other AI reviewers — `existing_instructions`
lists `.github/copilot-instructions.md`, `.github/instructions/`,
`REVIEW.md` or `AGENTS.md`, or there is a `.cursor/` directory — ask
whether to export the new rules for them too, naming the tools found. On
yes, run this, with `--to` listing those tools (`copilot`, `review` for
Claude Code Review, `agents`, `cursor`), and show the files it reports:

```bash
node "${CLAUDE_PLUGIN_ROOT}/cli/reviewlore.mjs" export --to copilot,review
```

Remind the user that the rules quote reviewers by
GitHub handle, so they should review them before committing — especially
in a public repository — and that re-running this skill later refreshes
the rules as review culture changes. In one line each, mention: while
editing, they can ask what reviewers said about a file (the plugin's MCP
server looks it up), and a scheduled GitHub Action can keep the rules
fresh (`examples/github-action/` in the reviewlore repository).
