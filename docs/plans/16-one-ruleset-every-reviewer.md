# 16 — One ruleset for every AI reviewer

**Priority:** P1 · **Effort:** M (≈ 3 days) · **Depends on:** none (uses 15's inventory if present)

## Problem

The plugin writes its best rules — the Claude-synthesised ones — only as
`.claude/rules/pr-feedback-*.md`. Teams also review PRs with GitHub
Copilot code review, Claude Code Review, Cursor or AGENTS.md-reading
agents, and those tools probably never see the rules. The CLI can emit
other formats, but only from its weaker heuristic clusters, and its
Copilot output is one unscoped file. Positioned well, this toolkit is the
in-repo source of truth that *every* reviewer reads; today it is mostly a
Claude Code feature.

## Audit findings

- Plugin path: SKILL.md step 4 writes only `.claude/rules/pr-feedback-*.md`.
- CLI formats (`lib/renderers/index.mjs`): claude, cursor, copilot,
  contributing, json, html, aider, agents, windsurf — all rendered from
  heuristic clusters (`normalizeAll(clusters, synth)`), never from the
  skill's rule files.
- `lib/renderers/copilot.mjs:1-13` writes a single
  `.github/copilot-instructions.md` managed section; no path scoping.
- GitHub Copilot supports path-specific instruction files:
  `.github/instructions/NAME.instructions.md` with frontmatter
  `applyTo: "glob,glob"` (comma-separated globs in one string) and
  optional `excludeAgent: "code-review" | "cloud-agent"`; they are read by
  Copilot code review and the cloud agent; when a repo-wide file also
  exists both are used
  ([GitHub docs](https://docs.github.com/en/copilot/how-tos/configure-custom-instructions/add-repository-instructions)).
- Claude Code Review (the hosted PR reviewer) reads `CLAUDE.md` files
  (root, and those in parent directories of changed files) and
  `REVIEW.md` (root plus optional subdirectory `REVIEW.md` files); a root
  `REVIEW.md` can include up to eight root-level files with `@name.md`
  lines, ≤ 150,000 bytes combined, ≤ 64 non-http links; includes are
  honoured only when `REVIEW.md` is read from a protected branch. The
  docs do not mention `.claude/rules/`
  ([code review customize](https://code.claude.com/docs/en/code-review-customize.md)).
  So our generated rules likely don't reach Claude Code Review today
  (unverified — the docs are silent, not explicit).
- The local `/code-review` command reads `CLAUDE.md` files, not
  `REVIEW.md` (same page).
- Competitor context: one mined ruleset that feeds Copilot, Claude Code
  Review, Greptile (reads CLAUDE.md and `.cursor/rules`) and AGENTS.md
  agents is a differentiator; hosted competitors keep learnings in their
  own dashboards (see `docs/plans/README.md` positioning notes).

## Goals / Non-goals

**Goals**
- `.claude/rules/pr-feedback-*.md` is the source of truth (it is what the
  skill writes and the user reviews).
- A deterministic `export` turns those files into every other format,
  preserving path scoping where the target supports it.
- The skill offers the export after writing, based on which tools the
  repo already uses.

**Non-goals**
- A model call in `export` (it's a pure transform).
- Exporting hand-written rules (only `pr-feedback-*` files with our
  provenance comment).

## Options considered

1. **Skill writes every format itself:** flexible but non-deterministic,
   duplicates formatting rules in prose, hard to test. Rejected.
2. **`export` subcommand reading the rule files (chosen):** deterministic,
   testable, usable from the skill, the CLI and CI.
3. **Make renderers accept parsed rule files instead of clusters:**
   right long-term internally — `export` is built on this: a parser
   produces the canonical `Rule` shape `_common.mjs` already defines, and
   existing renderers consume it.

## Design

### Command

```bash
reviewlore export --to copilot,review,agents,cursor [--target .] [--dry-run]
reviewlore export --to auto        # formats whose files already exist in the repo
```

Reads `.claude/rules/pr-feedback-*.md`, parses each into
`{ id, title, body, why, paths[], examples[], source }` (frontmatter
`paths`, H1 title, body until `**Why:**`, examples list), and renders:

| Target | Output | Scoping |
|---|---|---|
| `copilot` | `.github/instructions/pr-feedback-<id>.instructions.md`, `applyTo: "<globs joined by ,>"` (`"**"` when unscoped) | per rule |
| `review` | `review-pr-feedback.md` at the root + one line `@review-pr-feedback.md` added to `REVIEW.md` inside a managed block (created if missing) | per-rule "Applies to:" line in prose; optionally subdirectory `REVIEW.md` when every glob of a rule is under one directory |
| `agents` | managed section in `AGENTS.md` (existing renderer) | prose "When editing …" |
| `cursor` | `.cursor/rules/pr-feedback-<id>.mdc` with `globs` | per rule |
| `claude-md` | managed section in `CLAUDE.md` importing nothing — for `/code-review` and Code Review users who want rules in CLAUDE.md (opt-in, warns about always-loaded context) | none |

- Every output carries the provenance comment and the source links, so
  readers of any format can verify a rule.
- Removing a source rule file removes its exported copies on the next
  export (outputs are tracked by the `pr-feedback-` prefix / managed
  markers; hand-written files are never touched).
- `REVIEW.md` limits enforced: warn if the include would push the
  combined size near 150,000 bytes; never add a ninth include.

### Skill integration

SKILL.md step 5 (wrap up): if `existing_instructions` (plan 15) or the
repo tree shows `.github/copilot-instructions.md`,
`.github/instructions/`, `REVIEW.md`, `AGENTS.md` or `.cursor/`, offer:
"Also export these rules for Copilot / Claude Code Review / …?" and run
`export --to <detected>` on yes, showing the files written.

### CLI integration

_Status (October 2026): `export` and the skill offer are implemented.
The `run --format copilot` switch below is not done yet: it changes
existing users' file layout, so it needs the one-release deprecation
path described here._

`run --format copilot` switches to path-scoped instruction files (one per
rule) instead of the single file; the old single-file layout stays
available as `--format copilot-single` for a release, with a deprecation
note.

## Implementation steps

1. `lib/rule-files.mjs` (new): `parseRuleFile(text, path)` →
   `Rule`; `listGeneratedRules(targetDir)`.
2. `lib/renderers/copilot.mjs`: path-scoped mode; keep single-file mode
   under a new renderer name.
3. `lib/renderers/review.mjs` (new): root include file + managed
   `@` line in `REVIEW.md`.
4. Make agents/cursor renderers accept `Rule[]` (they already go through
   `normalizeAll`; add an entry point that skips normalisation).
5. `bin/commands/export.mjs` (new) + dispatcher entry in
   `bin/reviewlore.mjs`; help text; alias not needed.
6. SKILL.md wrap-up step; README "For teams" (one ruleset, every
   reviewer); docs/cli.md (`export` section, formats table).
7. check-pack REQUIRED for new files; CHANGELOG.

## Tests & verification

- Round trip: render a cluster to a Claude rule, parse it back, export to
  each format; snapshot tests per format (paths/globs, managed markers,
  provenance, links).
- Idempotence: running export twice yields no diff; deleting a source
  rule removes its exports; hand-written files untouched.
- `REVIEW.md` limits: include count and byte warnings.
- Manual: open a test PR on a scratch public repo with Copilot code
  review enabled to confirm instructions are applied (owner action;
  record the result in the plan).

## Docs & changelog

docs/cli.md (export), README (For teams), how-it-works (Scope section),
TROUBLESHOOTING ("Copilot doesn't apply the rules": check code review
custom-instructions setting; "Code Review ignores REVIEW.md includes":
protected branch), CHANGELOG.

## Risks, compatibility & rollback

- Copilot format change (single → per-rule files) changes users' file
  layout: ship behind the new default with the old renderer kept one
  release.
- REVIEW.md semantics differ from Claude rules (severity, "always
  check"); exported text should read as review checks ("Flag changes
  that …") — the renderer rephrases the title line only, never the
  evidence.
- Rollback: `export` is additive; deleting exported files restores the
  previous state.

## Cross-cutting checks

- No credentials, no network. Deterministic output (sorted by id).
- Privacy: exports copy the same quotes/handles; plan 11's anonymise
  option must apply to exports too.
- Windows: write with `/` in globs; file paths via `path.join`.

## Success metrics

- One command exports a skill-generated ruleset to Copilot, Claude Code
  Review and AGENTS.md with no hand edits.
- README/launch messaging: "works with Claude Code, Copilot code review,
  Claude Code Review, Cursor, and AGENTS.md agents" backed by tests.

## Open questions for the owner

1. Should the skill export automatically when it detects another tool,
   or always ask? (Default here: ask.)
2. Is a `CLAUDE.md` export worth offering, given the context cost of
   always-loaded rules?
