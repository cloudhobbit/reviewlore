---
description: Fetch PR comments from a target GitHub repo and write Claude rules into it
---

# /generate-skills-from-prs

End-to-end pipeline: GitHub repo → recurring reviewer feedback →
`.claude/rules/*.md` skill files inside the target repo.

## Inputs needed from user

Ask for these up-front (don't guess):

1. **GitHub owner + repo** — e.g. `facebook/react`
2. **Target local repo path** — where the generated `.claude/rules/`
   should be written (must be a checkout of a project the user works in).
3. **Lookback months** (default 6)
4. **Quality thresholds** (default `--min-occurrences 3 --min-authors 2`)

Confirm `GITHUB_TOKEN` is set in the environment.

## Step 1 — Fetch

```bash
GITHUB_TOKEN=$GITHUB_TOKEN reviewlore fetch \
  --owner <OWNER> --repo <REPO> \
  --months <MONTHS> \
  --out ./pr-comments-cache
```

This writes `pr-comments-cache/pr-comments-<repo>-<timestamp>.json`.

## Step 2 — Dry-run, show the user what would be generated

```bash
reviewlore generate <path-to-json> \
  --target <TARGET_REPO_PATH> \
  --dry-run --summary
```

Read the printed summary back to the user. Each cluster shows the topic
label, occurrence count, distinct authors, and distinct PRs. Ask the
user:

- Are the clusters meaningful? Or is the lookback too noisy?
- Should thresholds change?
- Are any clusters obvious false positives that should be filtered?

## Step 3 — Write

Only after the user approves:

```bash
reviewlore generate <path-to-json> \
  --target <TARGET_REPO_PATH> \
  --min-occurrences <N> --min-authors <M>
```

## Step 4 — Hand off for review

Tell the user:

1. The files are written to `<TARGET>/.claude/rules/pr-feedback-*.md`.
2. They should `git diff` the target repo and **edit or delete** any rule
   that doesn't look right. Heuristic clustering produces false positives;
   the citations under `## Examples from PR review history` show the
   source comments so the user can sanity-check.
3. Commit the kept rules into the target repo so they apply across
   teammates' Claude Code sessions.
