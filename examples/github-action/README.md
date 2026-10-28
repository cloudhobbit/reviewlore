# GitHub Actions: keep review history and rules fresh

Two copy-paste workflows. Pick one.

| Workflow | For | What the PR contains |
|---|---|---|
| [`refresh-review-corpus.yml`](./refresh-review-corpus.yml) (recommended) | Teams using the Claude Code plugin | The refreshed `.reviewlore-corpus.json`; the PR description is `reviewlore rules status` — which rules still have support, which have aged-out quotes to refresh, which point at paths that no longer exist. No rule is rewritten and no API key is needed: a developer runs the `learn-from-reviews` skill to act on it. |
| [`regenerate-heuristic-rules.yml`](./regenerate-heuristic-rules.yml) | Teams without the plugin | The corpus plus heuristically regenerated rule files for your chosen formats. It never overwrites rules the plugin wrote or rules edited since they were generated. |

## What the recommended workflow does

On every run (weekly cron + manual `workflow_dispatch`):

1. **Fetches** new PR comments with the workflow's own `GITHUB_TOKEN`
   (no extra secrets for the same repo), from a cache restored from the
   last run.
2. **Publishes the corpus** as `.reviewlore-corpus.json`, unchanged when
   there are no new comments — so no comments, no PR.
3. **Checks the rules** with `reviewlore rules status` and uses the report
   as the PR description; the title says how many rules need attention.

## Why the corpus matters

After the first run, the `.reviewlore-corpus.json` file lives
in the repo. From that point forward, **every developer can run
`reviewlore run` locally with zero GitHub token** — the
toolkit auto-detects the corpus and uses it instead of calling the
API. No PAT to generate, no `gh auth` to switch, no environment
variables to set.

The corpus is regenerated on every workflow run (typically weekly) so
it stays fresh. If a developer wants the very latest, they can re-fetch
manually with `--refresh`.

## Install

Recommended: copy `refresh-review-corpus.yml` to
`.github/workflows/refresh-review-corpus.yml`, commit and push. That's all.

For the heuristic workflow:

1. Copy `regenerate-heuristic-rules.yml` into your repo at
   `.github/workflows/regenerate-heuristic-rules.yml`.
2. Set `FORMAT` in the `env:` block — `claude`, `cursor`, `copilot`,
   `agents`, `aider`, `windsurf`, `contributing`, `html`, `all`, or a
   comma-separated list. Optionally add a
   [preset](../../docs/cli.md#presets) to the "Regenerate rules" step.
3. (Optional) For API-synthesised rules, add an `ANTHROPIC_API_KEY` repo
   secret and follow step 4 in the workflow's header comment.
4. Commit and push. The first run fires on the next scheduled tick;
   you can also trigger it immediately from the Actions tab.

## Why this matters

Without the Action, the toolkit is a one-shot tool — you run it, commit
the output, and it goes stale. With the Action, your AI tool's
understanding of your team's conventions keeps pace with new reviewer
patterns automatically. A new "use `pino` not `console.log`" convention
that emerges in October becomes a rule by November without anyone
remembering to re-run anything.

## What the heuristic workflow opens

A PR with a single commit titled `chore(rules): regenerate from PR feedback`,
showing the diff of `.claude/rules/` / `.cursor/rules/` / wherever your
format writes, plus the refreshed corpus. The PR body explains how to
handle false positives.

## Tuning

- **Too noisy?** Add `--preset team-of-50` (tighter thresholds), or
  `--min-occurrences 5 --min-authors 3`, to the "Regenerate rules" step.
- **Too sparse?** Use `--preset team-of-3` or `exploratory`, or a longer
  window: set the `months` input (or `MONTHS`) to 12.
- **Want better rules than the heuristic?** Have someone run the Claude
  Code plugin's `learn-from-reviews` skill against the committed corpus
  — it needs no token.
- **Want a dashboard for stakeholders?** Add `,html` to `FORMAT` — a
  `reviewlore-report.html` will be regenerated each run and
  included in the PR.

## Cost

- GitHub Actions: free for public repos; private repos use Actions
  minutes. The first run fetches the whole window (reviews come 25 PRs
  per GraphQL request, but comments are listed 100 at a time, bots
  included, so a very busy repo can need about 1,000 requests — the
  Actions token's hourly limit. If that happens, fetch once locally and
  commit a corpus with `publish-corpus`: the workflow seeds from it); later runs restore the previous run's cache (or seed it from
  the committed corpus) and fetch only what's new. A run where neither the
  comments nor the resulting rules changed leaves every file as it was,
  so no PR is opened.
- `--llm` (if enabled): roughly $0.02–$0.20 per regeneration with
  `claude-sonnet-5-5`.
