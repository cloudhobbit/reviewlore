# 01 — Release and distribution: from "works on main" to "a stranger can install it"

**Priority:** P0 · **Effort:** M (≈ 3–4 days of maintainer work, plus owner-only steps and directory review wait time) · **Depends on:** the naming decision in 12 (must be settled before the first public release); 04's `bin/` → `cli/` move if a claude.ai / Cowork listing is wanted at launch

## Problem

Nobody outside the owner can use the toolkit today. The GitHub repo is
private, so `/plugin marketplace add cloudhobbit/reviewlore`
fails for everyone else; `npx -y reviewlore` 404s because
nothing was ever published; and the release workflow cannot publish (no
`NPM_TOKEN`, and `--provenance` is refused for a private repository).
The README advertises both install paths as if they worked.

## Audit findings

- **Versions.** `package.json`, `.claude-plugin/plugin.json` and
  `const VERSION` in four `bin/` files are all `0.2.2`. Local tags
  `v0.2.1` and `v0.2.2` exist; CHANGELOG `[0.2.2]` says the v0.2.1
  release run never succeeded. Whether the tags were pushed and whether
  any `release.yml` run reached `npm publish` could not be verified
  (no GitHub API calls in this audit). npm returns 404 (brief).
- **`release.yml`** (`.github/workflows/release.yml`): tag `v*` →
  ubuntu+macOS × Node 20/22/24 tests → `publish` job on Node 24 with
  `permissions: id-token: write`, a tag/version check, then
  `npm publish --provenance --access public` with
  `NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}` (last lines of the file).
  `id-token: write` is already there, so trusted publishing needs only
  workflow edits, not new permissions.
- **npm trusted publishing** ([docs.npmjs.com/trusted-publishers](https://docs.npmjs.com/trusted-publishers)):
  needs npm CLI ≥ 11.5.1 and Node ≥ 22.14.0, GitHub-hosted runners,
  `id-token: write`, and the workflow *filename* (`release.yml`)
  registered on npmjs.com. Provenance is automatic (no `--provenance`
  flag needed) but **is not generated for private repositories** — the
  current workflow would fail on provenance even with a token. A new
  trusted-publisher config must complete a publish within 2 days. The
  docs don't say whether a package that doesn't exist yet can be
  configured; third-party guides say the first publish must be manual
  (unverified — check on npmjs.com at release time). Whether Node 24's
  bundled npm is ≥ 11.5.1 was not verified; pin it explicitly.
- **`scripts/update-version.js`** syncs `bin/reviewlore.mjs`,
  `bin/commands/{fetch,generate,mcp}.mjs` and `plugin.json`'s `version`
  on `npm version` (`package.json` `scripts.version` also `git add`s
  them). It does not touch `marketplace.json` (which has no `version`,
  correctly — `plugin.json` wins and validate warns on a mismatch).
- **Two release procedures disagree.** `CONTRIBUTING.md:103-108` says
  commit the CHANGELOG move first, then `npm version`;
  `.claude/commands/release.md` step 4 edits CHANGELOG *after*
  `npm version` has already tagged, so the tag would not contain the
  changelog. Its checklist still asks for `NPM_TOKEN`.
  `CONTRIBUTING.md:118-120` says to "allow read/write workflow
  permissions", which the workflow doesn't need.
- **Plugin versioning** ([plugins reference](https://code.claude.com/docs/en/plugins-reference),
  [loading](https://code.claude.com/docs/en/plugins/loading.md#versions-and-updates)):
  a `version` in `plugin.json` pins every install to that string until
  it changes; without one, a git-hosted marketplace uses the 12-char
  commit SHA. Auto-update is **off by default for third-party
  marketplaces**, so users only get a release when they run
  `claude plugin update` or turn auto-update on. New installs fetch the
  default branch's HEAD — i.e. unreleased `main` code labelled with the
  last released version.
- **Names are permanent** ([publish](https://code.claude.com/docs/en/plugins/publish.md)):
  installs are keyed by `name@marketplace`; a rename breaks existing
  installs unless the marketplace adds a `renames` entry. Plugin and
  marketplace are both named `reviewlore`, so the install id is
  `reviewlore@reviewlore`. One-command install exists:
  `/plugin install <name> --marketplace owner/repo` (Claude Code ≥
  v2.1.275) or `claude plugin install … --marketplace …` (≥ v2.1.292).
- **Git history.** Scanned every added line for GitHub/AWS/Anthropic/
  Slack/npm token patterns: 0 hits (one fake PEM header in
  `test/secret-scan.test.mjs`). The private history holds details that
  aren't for publishing, none of them credentials, so the public
  repository starts from a squashed snapshot instead (step 2).
- **Third-party content.** `examples/real-repos/**` quotes 11 public
  reviewers by handle (27 files; e.g. 15 quotes from one vitest
  maintainer); README.md quotes two of them. `eval/real/comments.json`
  pseudonymises authors (`user-1`…) but keeps each comment's
  `html_url`, so authors are one click away. All are public GitHub
  comments; MIT licence (`LICENSE`, 2026, Apoorv Mittal) covers our
  code, not their words.
- **Anthropic directory checks** ([pre-submission checklist](https://claude.com/docs/plugins/pre-submission-checklist)),
  applied to this repo, where the plugin folder is the repo root:
  top-level `bin/` → claude.ai/Cowork **can't install** it
  ([platform support](https://claude.com/docs/plugins/platform-support));
  `eval/real/comments.json` > 256 KiB → held; `.npmrc` setting a
  registry next to a lockfile install → held; lockfile install → always
  held; reading `GITHUB_TOKEN` / `gh auth token` from the machine and
  sending it to a server → "Uses a credential from the user's machine",
  held. README ≥ 40 words, licence, `name`/`version`/`author`: pass.
  Submission needs a paid claude.ai plan; `claude-plugins-official`
  takes no open submissions. A `CLAUDE.md` at the plugin root makes
  `claude plugin validate` warn, so `--strict` fails today
  (not run here; per the manifest reference).
- **Discovery.** Official listings show a per-turn context cost
  (highlighted at ≥ 2,000 tokens); our own marketplace shows none
  ([measure](https://code.claude.com/docs/en/plugins/measure.md)).
  Relevance suggestions only work for admin-allowlisted marketplaces
  ([relevance](https://code.claude.com/docs/en/plugins/relevance.md)).
  Community discovery happens in third-party directories
  (claudemarketplaces.com, claudepluginhub, awesome lists) — not
  verified individually.
- `package.json` `description` still says "Three CLIs: fetch-pr-comments
  … pr-comments-to-skills …", which will be the npm listing text.

## Goals / Non-goals

**Goals:** public repo with no surprises in history; 0.3.0 on npm via
tokenless trusted publishing with provenance; plugin installable by
anyone with one command; a release procedure that one document
describes; listings in at least the community directories.

**Non-goals:** rewriting history beyond what the owner decides below;
a claude.ai/Cowork listing before 04's `bin/` move; paid promotion.

## Options considered

1. **Long-lived `NPM_TOKEN` secret** (current docs). Works, but a
   stored publish token is exactly what npm now recommends against.
2. **Trusted publishing (OIDC) after one manual bootstrap publish.**
   No stored secret; provenance automatic once the repo is public.
   Needs the repo public *before* the CI publish.
3. **Publish the plugin from the npm tarball** (`npm` plugin source).
   Curated contents (no `eval/`, `.npmrc`, `CLAUDE.md`), but needs
   `npm-shrinkwrap.json`, puts `.claude-plugin/` and `skills/` in the
   npm package, and the version computes as `unknown` without the
   manifest field. Worth revisiting with the directory submission (see
   04), not for launch.

**Chosen:** 2 for npm; keep the repo-root relative-path plugin for the
GitHub marketplace at launch.

## Design

**Release model.** One version number for npm package, plugin and CLI
(already enforced by `update-version.js`). Plugin users get releases
because `plugin.json` changes with every `npm version`; `main` between
releases is what *new* installs see, so `main` must stay releasable
(CI green, CHANGELOG `[Unreleased]` accurate). Document in README:
"Update with `claude plugin update reviewlore@reviewlore`,
or turn on auto-update for this marketplace in `/plugin` →
Marketplaces."

**`release.yml` publish job (after bootstrap):**
```yaml
permissions: { contents: read, id-token: write }
steps:
  - uses: actions/checkout@v5
  - uses: actions/setup-node@v5
    with: { node-version: 24, registry-url: "https://registry.npmjs.org" }
  - run: npm install -g npm@^11.5.1   # trusted publishing floor
  - (tag/version check, unchanged)
  - run: npm ci
  - run: npm publish --access public   # OIDC; provenance automatic
```
No `NODE_AUTH_TOKEN`. Add `claude plugin validate --strict .` to CI
only once 04 removes the root-`CLAUDE.md` warning (or run without
`--strict` until then) — requires installing Claude Code in CI; if
that's not acceptable, keep it a local release-checklist step.

**Launch messaging** (README hero + listings): "Your team's review
conventions, as rules in your repo: reviewable, evidence-cited (every
rule links the PR comments behind it), works with whoever reviews your
code — human or bot — and no hosted dashboard." Contrast with
review bots that keep learned conventions in their own dashboards
(CodeRabbit, Greptile, Cursor Bugbot, Ellipsis, Baz, Cubic); cite the
Cursor forum request for exactly this
([forum thread](https://forum.cursor.com/t/api-or-git-based-workflow-to-promote-bugbot-learned-rules-into-repository-rules/171018))
and acknowledge the DIY prompt recipe
([rush.be](https://rush.be/insights/mining-pr-comments-for-agent-review-rules))
as the free alternative we automate and measure.

## Implementation steps

Owner-only steps are marked **[owner]**.

1. **[owner] Decide naming** (plan 12): plugin `name`, skill name,
   marketplace name. Must happen before step 8; renames after launch
   need a `renames` entry and still confuse users.
2. **History: decided — a squashed snapshot.** The public repository
   starts from one commit, so the private history isn't published.
3. Build it with `scripts/make-public-snapshot.sh` (GitHub noreply
   author address). Before committing, it checks an export for
   credential patterns, the private history's author emails and
   home-directory paths, and runs `npm ci`, the tests and check-pack.
4. **[owner] Third-party content.** Keep `examples/real-repos/` (public
   comments, linked, illustrative) but add a short notice to
   `examples/real-repos/README.md`: sources, that quotes are verbatim
   public review comments, and a takedown contact. Same note in
   `eval/real/README.md`. Optional courtesy: tell the vitest/pnpm
   maintainers quoted in the README hero.
5. Fix docs to one procedure: `CONTRIBUTING.md` Releasing section and
   `.claude/commands/release.md` (CHANGELOG first, then `npm version
   minor`, then push; remove `NPM_TOKEN` and "read/write permissions";
   add "bootstrap" and "trusted publisher" first-time steps). Update
   `package.json` `description` to one CLI + plugin.
6. Edit `.github/workflows/release.yml` publish job as in Design
   (keep the old `NODE_AUTH_TOKEN` line only until step 10 succeeds).
7. Add to README: update/auto-update instructions; the one-command
   install `/plugin install reviewlore --marketplace
   cloudhobbit/reviewlore` (≥ v2.1.275) next to the two-command
   form; Node ≥ 20.11 requirement (see 04).
8. **[owner] Make the repo public** (GitHub settings). Enable secret
   scanning + push protection, Dependabot alerts, private vulnerability
   reporting; add `SECURITY.md` (how to report, supported versions).
9. **[owner] Bootstrap npm**: create/verify the npm account with 2FA;
   publish 0.3.0 once manually *or* configure the trusted publisher
   first if npmjs.com allows it for an unpublished name; then
   Settings → Trusted publisher → GitHub Actions →
   `cloudhobbit/reviewlore`, workflow `release.yml`; then
   Publishing access → "Require two-factor authentication and disallow
   tokens"; revoke any automation token.
10. Cut 0.3.0: move `[Unreleased]` → `[0.3.0] — date`, commit,
    `npm version minor`, `git push && git push --tags`. If step 9 did a
    manual 0.3.0, cut 0.3.1 through CI to prove the pipeline instead.
11. Verify (see Tests). Then delete the `NODE_AUTH_TOKEN` line.
12. **[owner] Listings**: add to claudemarketplaces.com, claudepluginhub
    and relevant awesome-claude-code lists; GitHub topics
    (`claude-code-plugin`, `claude-code`, `code-review`); npm keywords
    already fine. Anthropic directory submission waits for 04 (bin move,
    eval data, `.npmrc`, token via `userConfig` decision) — expect
    reviewer holds for the lockfile install regardless.
13. **[owner] Launch posts** (Show HN / r/ClaudeAI / X / LinkedIn) with
    the demo from 12 and the messaging above.

## Tests & verification

- Pre-release: `npm test && npm run audit:all && npm run eval &&
  npm run eval:real` (unchanged gates); `claude plugin validate .`;
  `claude plugin eval` once 04/12 add eval cases (publish checklist
  step 6, [publish](https://code.claude.com/docs/en/plugins/publish.md));
  `claude plugin details reviewlore` to record the per-turn
  context cost for listings.
- After publish: `npm view reviewlore@0.3.0` shows provenance;
  in a clean container `npx -y reviewlore@0.3.0 --version`
  and `generate --demo`.
- Plugin, fresh machine/user: two-command and one-command installs;
  `/plugin` shows 0.3.0; skill runs on a public repo; `/mcp` shows
  `reviewlore` connected. Then bump to 0.3.1 and confirm
  `claude plugin update` picks it up.
- History: re-run the pattern scan on the final public history.

## Docs & changelog

README (install, update, requirements, messaging), CONTRIBUTING
(Releasing), `.claude/commands/release.md`, `examples/real-repos/README.md`,
`eval/real/README.md`, new `SECURITY.md`, `docs/audit-history.md`,
CHANGELOG `[0.3.0]`.

## Risks, compatibility & rollback

- History rewrite breaks existing clones (only the owner's) and tags.
- First CI publish fails on OIDC config → fall back to a one-off manual
  publish with 2FA; never re-tag (CONTRIBUTING policy: fix forward).
- Bad release → `npm deprecate`, publish a fix; for the plugin, bump
  `version` again (users on auto-update move forward).
- Unreleased `main` reaches new plugin installs → keep `main` green;
  if that proves risky, move the marketplace entry to a `github` source
  pinned to the release tag (`ref: "v0.3.x"`), updated by the release.

## Cross-cutting checks

- **Credentials:** removes the only stored secret; no token handling
  added. History scan shows none committed.
- **Privacy:** the public repository starts from a checked, squashed
  snapshot; reviewer quotes carry a provenance/takedown note.
- **Determinism / deps / stdout:** unchanged; no new runtime deps.
- **Windows / plugin vs CLI:** install docs cover both paths; platform
  work is in 04.

## Success metrics

- `npm view` shows 0.3.0 with provenance; zero long-lived npm tokens.
- A stranger installs the plugin in ≤ 2 commands and gets a result
  (measured on a fresh account).
- Listed in ≥ 2 community directories within a week of launch.
- npm weekly downloads and GitHub stars tracked from launch week (no
  baseline exists).

## Open questions for the owner

1. ~~Rewrite history or publish as is?~~ Decided: a squashed snapshot.
2. Bootstrap publish manually from your machine, or wait for npm to
   accept a trusted publisher on an unpublished name?
3. Final plugin/skill/marketplace names (plan 12) — this blocks launch.
4. Submit to Anthropic's directory at 0.3.x, or after 04's restructure
   so it isn't Claude-Code-only and has fewer reviewer holds?
5. Keep `eval/real/comments.json` (with URLs) in the public repo, or
   move it out of the plugin folder / drop the URLs?
