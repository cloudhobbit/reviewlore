# Contributing to reviewlore

A small, dependency-light Node CLI plus a Claude Code plugin. The bar for
a change: **tests pass, the audits and evals are green, and the change
earns its complexity.**

## Quick start

```bash
git clone https://github.com/cloudhobbit/reviewlore
cd reviewlore
npm install
npm test            # Node test runner
npm run audit:all   # pack contents + secret scan + smoke install of the tarball
npm run eval        # synthetic fixture
npm run eval:real   # 540 labelled real review comments
npm run eval:skill  # gallery rule files vs. the comments they cite
```

Requires Node ≥ 20.11. No build step — plain ESM `.mjs`.

The repo's `.npmrc` pins the public npm registry, so a corporate
`~/.npmrc` can't leak private mirror URLs into `package-lock.json` (that
broke CI once — see the v0.2.2 changelog).

To try the plugin from your checkout:
`claude plugin marketplace add ./` then
`/plugin install reviewlore@reviewlore`. Run
`claude plugin validate .` after changing `.claude-plugin/` or `skills/`.

## Project shape

| Path | What lives there |
|---|---|
| `cli/reviewlore.mjs` | The CLI: `run`, `candidates`, `doctor`, `precedents`, `rules`, `init`, `publish-corpus`; dispatches `fetch` / `generate` / `mcp` / `export`. Not `bin/`: a plugin's `bin/` lands on the Bash tool's PATH and blocks claude.ai / Cowork installs |
| `cli/commands/` | `fetch`, `generate`, `mcp`, `export` — each exports `main(argv)` |
| `lib/` | All logic. No `process.exit`, no console output (fetch progress goes to a stream the CLI passes in); renderers, the cache and the rules manifest write files |
| `lib/renderers/` | One file per output format, all built on the `Rule` shape from `_common.mjs` |
| `.claude-plugin/`, `skills/` | Claude Code plugin manifests and the `learn-from-reviews` skill |
| `test/` | `*.test.mjs`, one per module (`node:test` + `node:assert/strict`) |
| `eval/` | Synthetic fixture eval and the real-data eval (`eval/real/`) |
| `scripts/` | Pre-publish audits and release helpers (not shipped) |
| `examples/` | Real-repo output gallery and the GitHub Action template |
| `.claude/rules/` | Conventions Claude follows in this repo. **Read these first.** |

## Conventions

Enforced by `.claude/rules/*.md`; the highlights:

1. **stdout is for the artifact, stderr for everything else**, so output
   can be piped.
2. **No new runtime dependencies** without a strong reason.
   `@octokit/rest` is the only required one; `@anthropic-ai/sdk` and
   `@modelcontextprotocol/sdk` are optional.
3. **Never log, echo or persist credentials.** `scripts/check-secrets.sh`
   blocks publishing on a match.
4. **`lib/` never exits or prints.** Argument parsing, console output and
   exit codes belong in `cli/`; keep decisions in pure functions.
5. **Deterministic output.** Same input, same output on any machine: use
   codepoint compares, never `localeCompare`, in sorts that affect output.
6. **Precision over recall** in anything that produces rules
   (`.claude/rules/skill-output-quality.md`).

## Making a change

1. Read the relevant `.claude/rules/` files.
2. Write the logic as a pure function in `lib/`, with a test in
   `test/<module>.test.mjs` first.
3. Wire it into `cli/`.
4. New shipped file? Add it to `REQUIRED` in `scripts/check-pack.sh`.
5. `npm test && npm run audit:all && npm run eval && npm run eval:real && npm run eval:skill`.
6. Add a `CHANGELOG.md` entry under `[Unreleased]`.

**Changing the `candidates` JSON?** The plugin skill reads it — update
`skills/learn-from-reviews/SKILL.md` in the same PR.

**Adding an output format:** implement
`{ name, describe, write(clusters, { targetDir, force, synth, meta }) → { written, skipped } }`
on top of `normalizeAll()` from `lib/renderers/_common.mjs`, use the
managed-block markers if you append to a shared file, register it in
`lib/renderers/index.mjs`, and test it in `test/renderers.test.mjs`.

## Tuning extraction

`lib/patterns.mjs` (sentence classifier), `lib/normalize.mjs` (cleaning,
bot filter) and `lib/signals.mjs` (thread/author filters) decide what
becomes a candidate. Tune against the real-data eval:

```bash
node eval/run-real-eval.mjs --verbose   # every misclassified comment + the sentence that triggered it
```

Work from the **dev** split (vitest, pnpm). Report the held-out **test**
split (express, commander.js, swr), but don't tune against it. Raise
`FLOORS` in `eval/run-real-eval.mjs` when you improve it; never lower
them. `eval/real/README.md` has the labelling rubric if you add labelled
comments.

## Releasing

Maintainers only.

```bash
npm test && npm run audit:all && npm run eval && npm run eval:real && npm run eval:skill
# move [Unreleased] → [x.y.z] — YYYY-MM-DD in CHANGELOG.md and commit that first
npm version minor        # syncs VERSION in cli/ and the plugin manifest, commits, tags
git push && git push --tags
```

The tag triggers `.github/workflows/release.yml`: the test matrix, a
tag/version check, then `npm publish` through npm trusted publishing
(OIDC — no stored token; provenance is attached automatically).
Plugin installs track the default branch but only update when
`plugin.json`'s version changes, so plugin users get the release when
`npm version` bumps it; existing installs don't pick up unreleased
commits on `main`.
If publishing fails, fix forward with a new version; don't re-tag.

**First public release (one-time, owner):**

1. Start the public repository `cloudhobbit/reviewlore` from a squashed
   snapshot of `main` (the private repo keeps its history). The script
   builds a parentless `public-main` commit without touching your
   checkout, after checking an export of it for credentials, the private
   history's author emails and home-directory paths, and running
   `npm ci`, the tests and check-pack there. It doesn't push:
   ```bash
   bash scripts/make-public-snapshot.sh --email <id>+<login>@users.noreply.github.com
   git push git@github.com:cloudhobbit/reviewlore.git public-main:main
   ```
   Enable secret scanning with push protection, Dependabot alerts and
   private vulnerability reporting on it.
2. On npmjs.com: sign in (2FA on), then add a **trusted publisher** for
   `reviewlore` — GitHub Actions, repository `cloudhobbit/reviewlore`,
   workflow `release.yml`. If npm won't configure it for a name that
   doesn't exist yet, publish 0.3.0 once by hand (`npm publish --access
   public` from a clean checkout of the tag) and configure it right
   after. A new trusted publisher must publish successfully within two
   days or it expires.
3. Set the package's publishing access to "Require two-factor
   authentication and disallow tokens".
4. Cut the release as above; if 0.3.0 was published by hand, cut 0.3.1
   through CI to prove the pipeline.

**Versioning.** The CLI surface (commands, flags, output paths) and the
`candidates` JSON shape are the public API; `lib/` is internal. Patch:
fixes and docs. Minor: new commands, flags, formats or behaviour.
Major: removing or renaming commands, flags or output paths.

**Rollback.** `npm deprecate reviewlore@<bad> "<reason>; use <good>"`
and publish a fix. Don't `npm unpublish` — it breaks users' lockfiles.

## Reporting bugs

Open an issue with the command you ran (token redacted), the stderr
output and `node --version`. For a rule-quality problem, include the
comments involved (or a redacted slice of the input JSON) — good reports
become labelled eval cases.

## Code of conduct

Be kind and assume good faith. This tool is about how teams give each
other feedback; let's model the good version of that here.
