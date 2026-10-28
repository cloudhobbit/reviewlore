# Adoption plans — index

Seventeen plans for making reviewlore something developers install,
trust and keep using. Each plan has the same shape: problem, audit
findings with file references and measurements, options, design, steps,
tests, risks, success metrics, open questions.

Written October 2026 against `main` at `4ae24bc`. Estimates are estimates.

## Positioning (from the competitive research)

Nearly every AI review product now learns from PR comments — CodeRabbit,
Greptile, Cursor Bugbot, Ellipsis, Baz, Cubic, Bito — but keeps what it
learns in a hosted dashboard. Users are asking for the opposite: learned
rules proposed as PRs, with links to the source comments, living in the
repo ([Cursor forum, Sep 2026](https://forum.cursor.com/t/api-or-git-based-workflow-to-promote-bugbot-learned-rules-into-repository-rules/171018)).
The free alternative is a prompt recipe
([Rush](https://rush.be/insights/mining-pr-comments-for-agent-review-rules)).

So the pitch is: **in-repo, reviewable, evidence-cited conventions that
every AI reviewer reads** — Claude Code, Copilot code review, Claude Code
Review, Cursor, AGENTS.md agents — with measured precision, and nothing
hosted. Three findings shape the plans:

- **Noise is why people abandon these tools.** Precision-first defaults
  and a published precision number are features, not caution.
- **Generic rules cost context and don't help** (an ICLR 2026 study:
  context files raised inference cost >20% without improving success;
  [arXiv 2602.11988](https://arxiv.org/abs/2602.11988)). Rules must be
  repo-specific → plan 15.
- **One-shot tools get forgotten** (Claude Code marks plugins unused for
  14 days as "Not used recently"). A daily-use loop matters → plans 06,
  09, 10.

## The plans

| # | Plan | Priority | Effort | Depends on |
|---|---|---|---|---|
| [01](./01-release-and-distribution.md) | Release and distribution | P0 | M, 3–4 d + owner steps | 12 (name) |
| [02](./02-github-enterprise.md) | GitHub Enterprise support | P1 | M, ~3 d | — |
| [03](./03-fast-fetch-and-timeouts.md) | Fast, resumable fetch; quiet inside Claude Code | P0 | M, 4–5 d | — |
| [04](./04-plugin-runtime-and-platforms.md) | Plugin runtime: Node preflight, Windows, claude.ai/Cowork | P1 (preflight P0) | M, 4–5 d | — |
| [05](./05-slim-corpus.md) | Slim committed corpus (16 MB → 1.2 MB, output-identical) | P1 | S–M, 2–3 d | — |
| [06](./06-useful-mcp-server.md) | MCP server worth having on | P1 | M, 4–5 d | — |
| [07](./07-multilingual-and-high-recall.md) | Raw mode: non-English and paraphrase-heavy reviews | P1 | M, 4–5 d | 13 |
| [08](./08-small-and-single-reviewer-repos.md) | Small and single-reviewer repos | P1 / P2 (org pooling) | M, ~3 d | 12, 15 |
| [09](./09-review-my-changes-skill.md) | "Review my changes" skill | P1 | M–L, 5–6 d | 06 |
| [10](./10-keeping-rules-fresh.md) | Keeping rules fresh (refresh, retire, promote via PR) | P1 | M, ~5 d | 06, 09 |
| [11](./11-privacy-and-trust.md) | Privacy and trust | P1 (README fix + secret scanning P0) | M, ~4 d | 05 |
| [12](./12-onboarding-and-first-run.md) | Onboarding and first run | P1 (naming decision P0) | M, ~4 d | — |
| [13](./13-measuring-plugin-quality.md) | Measuring the plugin's output quality | P1 (rule checker + AI-reviewer filter P0) | L, 6–8 d | — |
| [14](./14-other-code-hosts.md) | GitLab and Bitbucket | P2 | L, 8–10 d | 02 |
| [15](./15-rule-specificity-and-conflicts.md) | Rule specificity, conflicts, minimum data | P1 | M, 3–4 d | — |
| [16](./16-one-ruleset-every-reviewer.md) | One ruleset for every AI reviewer (`export`) | P1 | M, ~3 d | (15) |
| [17](./17-parallel-comment-fetch.md) | Faster first fetch: parallel time slices (added after live pnpm runs) | P1 | S–M, 1–2 d | 03 |

Total: roughly 65–80 working days for everything; about 20 days for
phases 0–1.

## Phase 0 — bugs found while planning ✅ done

Verified in the code during planning and fixed (see CHANGELOG
`[Unreleased]`). The MCP project-dir fix still needs one manual check in
a real plugin session (`claude --debug`).

| Bug | Where | Plan |
|---|---|---|
| `search_rules` matches topic words as substrings, so "add a changeset" matches almost everything via "a" | `lib/mcp-tools.mjs:63` | 06 |
| Remote parsing keeps owner/repo from any host and drops the host: on a GitHub Enterprise or GitLab checkout the CLI queries github.com for a same-named repo with the user's github.com token; GitLab subgroups are misread | `lib/git-info.mjs:20` | 02 |
| A corpus file with merge-conflict markers crashes `run`/`candidates` with a stack trace | `bin/reviewlore.mjs` (`corpusInfo` returns no `totals`) | 05 |
| `scripts/check-secrets.sh` prints matched secrets into CI logs (breaks the no-token-logging rule) | `scripts/check-secrets.sh:43-45` | 11 |
| Secret scan covers comment bodies only (not `diff_hunk`) and misses common token formats (PKCS#8, `ghu_`/`ghr_`, `glpat-`, npm, Stripe, JWT…) | `lib/secret-scan.mjs` | 11 |
| After an incremental fetch the cache records the wrong `since`; asking for more months than cached never backfills | `lib/cache.mjs` | 03, 05 |
| Without a TTY the fetcher logs one line per PR (~970 on pnpm) — into Claude's context when the skill runs it | `lib/fetchers.mjs` | 03, 12 |
| README says "Everything runs on your machine" — false for the plugin path, where quotes go to the model provider Claude Code uses | `README.md` Privacy | 11 |
| GitHub Action template: opens a PR every week even when nothing changed (timestamps churn); ~1,040 requests per run exceeds the Actions token's 1,000/hour; `--force` can overwrite plugin-written rules | `examples/github-action/` | 03, 10 |
| AI reviewers posting from user accounts aren't filtered: a strict detector removes 30 express comments (−36% candidates) and lifts held-out precision 69.6% → 72.7% with no recall loss | `lib/normalize.mjs` | 13 |
| The plugin's MCP server probably doesn't start in the user's repo, so the committed-corpus fallback likely fails in plugin mode — pass the project dir explicitly (needs a manual check) | `.claude-plugin/plugin.json` | 06 |

## Phase 1 — before going public (≈ 2–3 weeks) — engineering done

1. **Owner decisions** (below) — ✅ decided.
2. **01** release mechanics — ✅ trusted-publishing workflow, first
   public release steps in CONTRIBUTING, SECURITY.md. Owner steps left:
   create the public repo from a squashed snapshot, configure the npm
   trusted publisher, enable secret scanning / push protection.
3. **03** fast fetch — ✅ GraphQL reviews, rate-limit retries, progress
   with ETA, resume, `--time-budget`, Action cache. Not yet measured
   against live GitHub: run the REST-vs-GraphQL parity diff and timing
   on pnpm with a token before release (see 03's manual checks).
4. **04** P0 — ✅ `doctor`, `candidates --save/--discard`, skill
   preflight.
5. **11** P0 (Phase 0) and **13** P0 — ✅ `npm run eval:skill`
   (14/14 gallery rules pass), AI-reviewer filter.
6. **12** — ✅ naming; `/learn-from-reviews demo` (`candidates --demo`).

Still to verify by hand (needs a working local `claude` login): the MCP
project-dir fix and the skill end to end in a real plugin session.

## Phase 2 — a first run people trust (≈ 3 weeks) — engineering done

- **15** ✅ `history` + `existing_instructions` in `candidates`; the skill
  warns on thin history, drops generic rules, labels NEW / DUPLICATE /
  VIOLATED / CONTRADICTS, reports context cost. Thresholds (50 PRs / 3
  reviewers / 80 %) flag exactly swr and commander.js in the gallery.
- **16** ✅ `reviewlore export` (copilot, review, agents, cursor,
  claude-md, auto) and the skill's offer. Not done: switching
  `run --format copilot` to per-rule files (needs a deprecation release).
- **05** ✅ slim corpus, byte-identical output on all five cached repos
  (pnpm 16.8 MB → 968 KB).
- **12** ✅ empty-result diagnosis, actionable GitHub errors, strict
  flags, team docs. `--estimate` dropped: plan 03 made it unnecessary.
- **13** remaining work needs people or a working `claude` login: a
  fresh held-out repo labelled blind (pre-register, fetch, label, second
  labeller on 20 %), and the `claude plugin eval` suite (B2). The gallery
  re-run that 15 expects (vitest's generic "add a test" rule dropped)
  also needs a real skill session.

## Phase 3 — weekly use (≈ 3 weeks) — engineering done

- **06** ✅ `review_feedback_for_path` / `search_review_feedback`, no
  arguments inside a repo; rules first, then BM25 over human comments;
  gallery check 10/14 (old tool 5/14); ~1 ms queries, big caches indexed
  in a child process. Unmeasured: how often Claude calls the tools in
  real sessions.
- **09** ✅ `/reviewlore:review-my-changes` + `reviewlore precedents`. Not
  done: the leave-one-PR-out replay and hand-labelled precision check.
- **10** ✅ `.claude/reviewlore-rules.json`, `reviewlore rules
  status|record|dismiss|retire`, skill refresh mode, and the
  `refresh-review-corpus.yml` Action (status report as the PR body).

Found on live data along the way: AI reviews posted from user accounts
(`[P2]` tags, "Automated review") and human replies to bot review threads
both looked like human feedback; both are now filtered. On pnpm, most
human inline comments in 2026 answer AI review bots, and some text from a
maintainer's account reads as AI-agent output — something no text filter
separates reliably.

## Phase 4 — reach (≈ 3–4 weeks)

**02** (GitHub Enterprise), **07** (non-English, high recall), **08**
(small and single-reviewer repos), the rest of **04** (Windows CI,
`bin/` → `cli/` for claude.ai/Cowork), then **14** (GitLab/Bitbucket).

## Decisions only the owner can make

Decided (October 2026): the name is **reviewlore** (package, CLI,
plugin); the public repo starts from a **squashed snapshot**; npm
releases use **trusted publishing**. The items below are kept for the
record.

1. **Plugin and skill name** — permanent after release (12, 01). Note
   that `/learn-from-reviews` likely works without the plugin prefix
   already (12), so a rename may not be needed.
2. **Git history before going public** (01): decided — the public repo
   starts from a squashed snapshot (`scripts/make-public-snapshot.sh`).
3. **npm publishing**: `NPM_TOKEN` secret vs npm trusted publishing
   (OIDC); provenance requires a public repo (01).
4. **Anthropic directory listing** (needs a paid plan) and what it would
   require: `bin/` move, root `CLAUDE.md`, the 768 KB eval file (01, 04).
5. **Privacy defaults**: quote reviewers by handle or anonymise by
   default (11).
6. **Thresholds**: thin-history warning (50 PRs / 3 reviewers) and the
   single-maintainer mode (08, 15).

## Cross-plan agreements made in review

- `candidates` gains one `history` block (`prs`, `reviewers`,
  `top_reviewer_share`, `warning`) defined in plan 15 and used by 08 and
  12.
- The skill writes `.claude/rules/pr-feedback-*.md` as the single source
  of truth; other formats are exported from those files (16), and
  refresh history lives in a separate committed file, not in rule
  frontmatter (10).
- Claude Code moves long commands to the background rather than killing
  them at 2 minutes (03, 04, 12 correct the original brief); the
  first-run problem is context noise and lost progress, not a hard
  kill.
