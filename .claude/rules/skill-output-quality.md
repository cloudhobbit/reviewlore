# reviewlore output must be reviewable, not auto-trusted

The skill files this tool writes into a target repo's `.claude/rules/`
will be read by Claude on every subsequent session in that repo. A
hallucinated or noisy rule has compounding cost.

**Why:** Heuristic clustering produces false positives. A reviewer joke
("never push to main on a Friday lol") clustered with serious advice
becomes a real-looking rule with `**Why:**` citations. The user must be
able to skim, delete, and edit the output — and the defaults must favour
precision over recall.

**How to apply:**
1. Every generated rule must cite ≥ 2 source PRs with URLs in
   `## Examples from PR review history`, so the user can verify the cluster
   makes sense.
2. Default thresholds (`--min-occurrences 3`, `--min-authors 2`) must stay
   strict. Don't lower them to "show more results" — recommend the user
   re-run with looser flags instead.
3. The `--dry-run` flow is the recommended first step in the README and
   in the `/generate-skills-from-prs` slash command, and the plugin's
   `learn-from-reviews` skill must show its proposed rules and wait for
   approval before writing. Never silently write to a target without
   offering this.
4. File names use the `pr-feedback-<slug>.md` prefix so it's obvious which
   rules came from this tool vs hand-written ones. Don't shorten or
   prefix-strip without thinking about the user's ability to bulk-delete
   a bad batch.
