# 12 — Onboarding and first run: time to first value

**Priority:** P1 (the naming decision inside it is P0: it must be settled before 01's first public release) · **Effort:** M (≈ 4 days: demo path 1.5, empty-result and estimate 1.5, messages + docs + recording 1) · **Depends on:** 04 (preflight, `candidates --save`); blocks 01 on naming only

## Problem

A new user's first ten minutes decide whether they keep the plugin.
Today the first run on a busy repo starts with several minutes of
GitHub fetching with no estimate, dumps hundreds of progress lines into
Claude's context, and on a small or single-maintainer repo ends with
"no rules" and no next step. There is no way to see what the plugin
produces before pointing it at your own repo with a token, and the
only demo (`generate --demo`) shows the weakest output path.

## Audit findings

- **Command name.** Plugin `reviewlore` + skill
  `learn-from-reviews` → `/reviewlore:learn-from-reviews`
  (README.md:55, TROUBLESHOOTING.md:11-12). But per the skills docs,
  because SKILL.md sets `name: learn-from-reviews`, "the bare `/fancy`
  also invokes the skill unless another command already uses that name"
  ([skills](https://code.claude.com/docs/en/skills.md)) — so
  `/learn-from-reviews` should already work; nothing documents it
  (not tested interactively in this audit). `argument-hint` is
  `"[months of history, default 6]"` (SKILL.md:4).
- **Names are permanent.** A renamed plugin is a different plugin to
  every existing install; migration needs a marketplace `renames` entry
  ([publish](https://code.claude.com/docs/en/plugins/publish.md)). Any
  plugin rename must happen before 01's launch; a skill rename changes
  only the command, but breaks muscle memory and docs.
- **Per-turn cost.** The skill description is 308 characters (≈ 80
  tokens); official listings highlight ≥ 2,000 tokens/turn
  ([measure](https://code.claude.com/docs/en/plugins/measure.md)). MCP
  tool schemas are counted separately (`/context`); not measured here.
- **Retention signal.** A marketplace plugin unused for 14 days and 10
  sessions moves under "Not used recently" in `/plugin` (measure.md). The
  skill is one-shot by design, so only the MCP tools and refreshes keep
  the plugin "used".
- **Zero-setup path exists only on the CLI.** `generate --demo`
  (`bin/commands/generate.mjs:100-120`) runs on
  `lib/fixtures/demo-typescript.json` (4.6 KB, 20 synthetic comments).
  Run here: 0.13 s, 2 rules, titled "Avoid: any / type / unknown / use"
  and similar, example URLs `u1`/`u2`, and a spurious
  "Warning: --target is not a git repository" for its own temp dir
  (`generate.mjs:153`). `candidates` has no `--demo` or input-file
  option, so the skill has no try-it path at all.
- **Real-data demo is cheap.** Trimming cached public corpora (human,
  PR-only, ≥ 20 chars, no `diff_hunk`): vitest 7.2 MB → 1.27 MB; its
  `candidates` output is 69 KB at `--limit 150`, 28 KB at `--limit 60`,
  0.2 s offline, with 10 clusters already at ≥ 2 PRs / ≥ 2 reviewers.
  A shipped file must stay < 256 KiB to avoid an Anthropic directory
  hold ([pre-submission checklist](https://claude.com/docs/plugins/pre-submission-checklist)).
- **First fetch.** `lib/fetchers.mjs:92-115` calls `pulls.listReviews`
  once per PR, sequentially. PRs in a 6-month window (from cached
  `meta.pr_authors`): pnpm 969, vitest 859, express 674, commander.js
  124, swr 54 → ≈ 1,000 requests for pnpm. Minutes per run is an
  estimate (≈ 0.3–0.5 s/request → 5–8 min); not measured live.
- **Progress floods Claude's context.** `lib/fetchers.mjs:12-14` writes
  one line per PR when stderr isn't a TTY — which it isn't under the
  Bash tool — so ≈ 970 lines on pnpm. The skill command doesn't
  redirect stderr, and Bash results over ≈ 30,000 characters are spilled
  to a file ([tools reference](https://code.claude.com/docs/en/tools-reference.md)).
  A command passing the 2-minute default timeout is moved to the
  background in interactive sessions; SKILL.md says nothing about either.
- **Empty results are a dead end.** Offline `candidates` on trimmed
  corpora: swr 5 candidates, commander.js 29, each cluster with
  `prs: 1, reviewers: 1`, 0 clusters at the 2/2 bar. `stats` holds
  `comments, candidates, clusters, shown` only — no PR or reviewer
  counts, so Claude can't say *why*. SKILL.md has no "nothing passed"
  branch; TROUBLESHOOTING.md:22-28 covers it only for readers who look.
  CLI `run` prints "No clusters met the thresholds. Try
  --min-occurrences 2 or a longer --months window."
  (`bin/reviewlore.mjs:469`).
- **Error messages** (`bin/reviewlore.mjs`, `bin/commands/*`):
  missing owner/repo prints the 100-line HELP after the error
  (`:278-281`); `run`/`candidates` fetch failures hint only for 401 and
  403 (`:427-429`) while `fetch` also hints 404 (`fetch.mjs:158`); 403
  doesn't distinguish rate limit from SAML-SSO / scope;
  `lib/git-info.mjs:21` accepts any host, so a GitLab remote becomes a
  GitHub 404 with no explanation; MCP missing-deps advice is wrong for
  plugin users (see 04). `parseArgs` silently accepts unknown flags, so
  typos do nothing.
- **Demo recording.** `scripts/record-demo.sh` records `generate --demo`
  plus echoed comments about `run`; no `docs/demo.cast` is committed and
  README embeds nothing. `docs/demo.md` suggests `run --dry-run
  --summary`, but `--summary` is a `generate` flag that `run` silently
  ignores. The plugin flow — the main product — isn't shown anywhere.
- **Team story.** README "For teams" (README.md:91-99) covers the
  committed corpus and the refresh Action, but not the core point:
  rules in `.claude/rules/` are committed, so every teammate's Claude
  Code loads them **without installing anything**; only the person
  generating them needs the plugin or a token.

## Goals / Non-goals

**Goals:** see real output inside Claude Code in < 1 minute with no
token; know the cost before a long fetch; never end on a bare "0
rules"; actionable errors; a short documented command; a README that
shows the plugin flow and the team multiplier.

**Non-goals:** faster fetching itself (concurrency, GraphQL — separate
plan); changing rule thresholds; non-GitHub hosts.

## Options considered

**Naming.** (a) Keep `reviewlore` / `learn-from-reviews`,
document `/learn-from-reviews`, add `displayName`. (b) Rename the
plugin (e.g. `review-rules`) before launch — shorter namespace but
diverges from the npm name and the repo. (c) Rename the skill (e.g.
`learn-conventions`). **Chosen: (a)** — zero migration risk; the bare
name is already short. Owner confirms before 01.

**Try-it path.** (a) Improve the synthetic fixture. (b) Ship a frozen
public snapshot (vitest `candidates`, ≈ 30–70 KB) and let the skill run
on it. (c) Point at a public repo live — needs a token. **Chosen: (b)**,
output never written to the user's repo.

**Cost preview.** (a) Search API `is:pr updated:>=…` total count, one
request, before fetching. (b) Count PRs from the list pages already
fetched, print the estimate before the per-PR loop. **Chosen: (a) as a
`--estimate` mode for the skill to ask before committing, plus (b) in
progress output** — (b) alone comes too late for the user to choose.

## Design

**Skill invocation.** SKILL.md frontmatter:
`argument-hint: "[months | demo]"`. README and TROUBLESHOOTING lead with
`/learn-from-reviews` (namespaced form as fallback). Add
`"displayName": "PR review conventions"` to `plugin.json`. Keep the
description ≤ 350 characters; check with `claude plugin details` each
release.

**Demo mode.** `candidates --demo` prints a bundled snapshot
`lib/fixtures/demo-candidates.json`: `candidates` output (`--limit 60`)
from vitest-dev/vitest, frozen at a date, with a `"demo": true` and a
`"source"` note; < 64 KB. When the skill argument is `demo`, Claude
runs it, synthesises and shows the proposal table exactly as for a real
repo, then says "This was a demo on vitest's public review history;
nothing was written. Run `/learn-from-reviews` in your repo to do it for
real." Never writes files in demo mode. `generate --demo` drops the
temp-dir git warning.

**Estimate.** `candidates --estimate` (needs auth as today): one search
request → stdout JSON `{ repo, months, prs, requests, minutes_low,
minutes_high, cached: bool, corpus: bool }`, where `requests = prs + 3 ×
ceil(prs/100)` and minutes from a pure `estimateFetch(prs)` in
`lib/fetchers.mjs` (0.3–0.5 s/request, labelled an estimate). With a
committed corpus or a fresh cache, returns `requests: 0`. SKILL.md step
1: if `requests > 300`, tell the user ("about 1,000 GitHub API calls,
roughly 5–8 minutes; a teammate can commit a corpus to skip this") and
ask whether to proceed or shorten `--months`; then run with the Bash
tool's 10-minute timeout and, if moved to the background, wait for it.

**Quiet progress for non-TTY.** `lib/fetchers.mjs` non-TTY logger
prints at most ~10 lines per stage (every 10 % of PRs) and one
"Found N PRs (≈ M requests)" line. Applies to CI logs too.

**Empty-result diagnosis.** Uses the `history` block that plan 15 adds to
`candidates` (the single definition shared by plans 08, 12 and 15):
`prs` (PRs with any human non-author comment), `reviewers` (distinct),
`top_reviewer_share` (share of human review comments from the most active
reviewer) and `warning`. SKILL.md "If nothing reaches the bar": say why in one
sentence from these stats (e.g. "one reviewer wrote 90 % of the
feedback"), then offer, in order: re-run with `--months 12` or `24`;
show the strongest single-reviewer conventions, clearly marked below
the bar and written only if the user confirms; commit a corpus / enable
the refresh Action to try again later; use the MCP server's
`recent_feedback` while editing. CLI `run` prints the same diagnosis.

**Error messages.** One helper `explainGitHubError(err, { owner, repo })`
in `lib/` returning text (no printing): 401 → token invalid/expired; 403
with `x-ratelimit-remaining: 0` → rate limited, reset time; 403 with
SAML text → "authorise your token for the org's SSO"; other 403 → scope;
404 → "not found, or your token can't see it (private repo?)". Used by
`run`, `candidates`, `fetch`. `detectRepoFromGit` returns `host`; a
non-github.com host → "only github.com repositories are supported".
Missing owner/repo prints one hint line, not HELP. Unknown flags →
error listing valid flags (per command).

**Team docs.** README "For teams" opens with: "One person runs the
skill and commits `.claude/rules/pr-feedback-*.md`. Everyone's Claude
Code loads those rules from the repo — teammates don't need the plugin,
a token, or Node." Then the corpus and Action bullets, and an optional
project `.claude/settings.json` snippet (`extraKnownMarketplaces` +
`enabledPlugins`) for teams that want the MCP server everywhere
(behaviour after the workspace-trust prompt to be verified per
[loading](https://code.claude.com/docs/en/plugins/loading.md)).

**README hero and retention.** Lead with the positioning shared with 01:
in-repo, reviewable rules, each citing its PR comments, from whoever
reviews your code — unlike review bots that keep learned conventions in
a hosted dashboard ([Cursor forum request](https://forum.cursor.com/t/api-or-git-based-workflow-to-promote-bugbot-learned-rules-into-repository-rules/171018);
DIY alternative: [rush.be prompt recipe](https://rush.be/insights/mining-pr-comments-for-agent-review-rules)).
The skill's wrap-up adds one line pointing at the MCP lookup ("ask what
reviewers said about a file before editing it") and at the refresh
Action, since a one-shot plugin drifts into "Not used recently".

**Demo recording.** Two artefacts: (1) the CLI cast from
`record-demo.sh`, switched to `candidates --demo | head` + the vitest
gallery rule; (2) a recorded Claude Code session of
`/learn-from-reviews demo` (asciinema or VHS), trimmed to ≤ 60 s,
converted with `agg` to a GIF < 5 MB, attached to a GitHub release and
linked from README (keeps large binaries out of the plugin folder).

## Implementation steps

1. **[owner]** Confirm naming (a) before 01 step 8.
2. `plugin.json` `displayName`; SKILL.md `argument-hint`; README /
   TROUBLESHOOTING use `/learn-from-reviews`.
3. `scripts/make-demo-fixture.mjs` (dev-only) builds
   `lib/fixtures/demo-candidates.json` from a cached corpus; commit the
   output; add to `check-pack.sh` REQUIRED.
4. `candidates --demo` in `bin/reviewlore.mjs` (before any
   repo detection or auth); SKILL.md demo branch.
5. ~~`estimateFetch` + `candidates --estimate`; SKILL.md step 1 cost
   gate~~ — dropped (October 2026): plan 03 brought a six-month pnpm
   fetch to ≈ 80 requests (the gate was at 300), and the skill now
   fetches in 90-second `--time-budget` steps that report progress, so
   no single command blocks. Revisit if live timings disagree.
6. Throttled non-TTY logger in `lib/fetchers.mjs`.
7. `history.prs/reviewers/top_reviewer_share` (plan 15) in `emitCandidates`;
   SKILL.md empty-result branch; CLI `run` diagnosis. Update
   CONTRIBUTING's "candidates JSON changed → update SKILL.md" in the
   same PR.
8. `lib/github-errors.mjs` + wiring; `git-info` host; strict unknown-flag
   check in `lib/args.mjs` (opt-in per command, to avoid breaking
   delegated stages).
9. `generate --demo`: skip the git warning for its temp dir.
10. README (hero GIF link, `/learn-from-reviews demo`, For teams),
    `docs/demo.md` (fix `--summary`), `scripts/record-demo.sh`.
11. **[owner]** Record the Claude Code session GIF.

## Tests & verification

- `test/cli.test.mjs`: `candidates --demo` works with `GITHUB_TOKEN=`
  and no git repo, output deterministic and < 64 KB; `--estimate` with
  a corpus returns `requests: 0` without auth; unknown flag errors;
  missing owner/repo prints one hint line.
- Unit: `estimateFetch`, `explainGitHubError` (fixture error objects
  with headers; no network), throttled logger (fake non-TTY stream),
  new `stats` on the trimmed swr/commander-like fixtures (expect
  `prs < 10`, `top_reviewer_share` high).
- Eval: `eval`/`eval:real` unaffected (extraction unchanged); assert so.
- Plugin eval: add a `claude plugin eval` case
  ([plugin evals](https://code.claude.com/docs/en/plugin-evals.md))
  that invokes `/learn-from-reviews demo` and grades that the skill
  fires, writes no files, and shows a proposal table — also guards
  triggering if the description is shortened.
- Manual: fresh install → `/learn-from-reviews demo` under 60 s;
  pnpm-sized repo without corpus → estimate prompt, no flood of
  progress lines; swr/commander.js → diagnosis + next steps, no files
  written; Windows run of the demo (with 04).

## Docs & changelog

README, TROUBLESHOOTING (plugin section), `docs/cli.md` (`--demo`,
`--estimate`, new `stats`), `docs/demo.md`, CONTRIBUTING (fixture
script), CHANGELOG `[Unreleased]`.

## Risks, compatibility & rollback

- Snapshot quotes real public reviewers; the gallery already does, but
  it now ships in the npm package and plugin → provenance note in the
  fixture and README; owner may prefer pseudonymised authors (URLs
  still resolve).
- Bare `/learn-from-reviews` can be shadowed by another plugin's skill;
  docs keep the namespaced form as fallback.
- Search API has a separate, low rate limit (30/min) — estimate is
  best-effort; on failure the skill proceeds without it.
- New `stats` fields are additive; SKILL.md ignores unknown fields.
- Strict flags could break scripts passing junk flags → error message
  names the flag; minor version bump.

## Cross-cutting checks

- **Credentials:** demo and corpus paths never resolve tokens; error
  helper never includes token text; skill still never reads creds.
- **Privacy:** demo fixture is public data with provenance; no new
  persistence.
- **Determinism:** fixture frozen; estimate pure; new stats sorted.
- **Deps:** none. **stdout/stderr:** JSON on stdout, progress on stderr.
- **Windows:** demo command is a plain `node` line (with 04's `--save`).
- **Plugin vs CLI:** diagnosis and errors shared by both.

## Success metrics

- Install → first proposed rules (demo) ≤ 60 s, 0 tokens/credentials.
- Real repo with corpus: invoke → proposal ≤ 3 min.
- 0 runs ending with "0 rules" and no next step in the five gallery
  repos (swr and commander.js show diagnosis + options).
- Progress output under the Bash tool ≤ 40 lines for pnpm.
- Always-on context cost (`claude plugin details`) stays < 200 tokens.

## Open questions for the owner

1. Keep the names (recommended), or rename now — the last cheap chance?
2. Demo snapshot with real handles or pseudonyms?
3. Should below-the-bar single-reviewer rules ever be written, or only
   shown?
4. Is a 300-request threshold for the "ask first" prompt right?
