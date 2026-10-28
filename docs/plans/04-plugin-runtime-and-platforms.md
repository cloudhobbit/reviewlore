# 04 — Plugin runtime and platforms: Node, dependencies, Windows, claude.ai/Cowork

**Priority:** P1 (the preflight and the shell-neutral skill command are P0 for launch) · **Effort:** M (≈ 4–5 days: preflight + skill 1.5, `bin/` → `cli/` move 1, Windows CI and fixes 1.5–2) · **Depends on:** none; 01 (directory submission) depends on the `cli/` move here; 12 reuses the preflight messages

_Status (October 2026): steps 1–5 and 7 done (`doctor`, `--save` /
`--discard`, skill preflight, messages, `bin/` → `cli/`, a Windows CI job
with `.gitattributes`). The Windows job is `continue-on-error` until its
first runs show what breaks (the suite was written on POSIX: symlinked
tool dirs, file modes). Step 6 (moving the root CLAUDE.md) isn't needed:
`claude plugin validate` passes with it (Claude Code 2.1.119 has no
`--strict`). Manual claude.ai / Cowork upload still untested._

## Problem

The plugin silently assumes `node` ≥ 20.11 and `npm` on the user's
PATH. Claude Code's native installer provides neither, so a user who
installed Claude Code the recommended way and has no Node sees the
skill fail with `node: command not found` (or a PowerShell "term not
recognized"), and the MCP server shows as failed in `/mcp` with no
explanation. The skill's one command is bash-only, so Windows users
without Git Bash can't run it at all. And claude.ai / Cowork refuse to
install the plugin because of its top-level `bin/` directory.

## Audit findings

- **Node is required everywhere.** `.claude-plugin/plugin.json` starts
  the MCP server as `"command": "node"` with
  `${CLAUDE_PLUGIN_ROOT}/bin/pr-comments-mcp.mjs`;
  `skills/learn-from-reviews/SKILL.md:29` runs `node
  "${CLAUDE_PLUGIN_ROOT}/bin/reviewlore.mjs" candidates`.
  `package.json` `engines.node` is `>=20.11`. The README's plugin
  section (README.md:46-68) and TROUBLESHOOTING's plugin section never
  mention Node; only the CLI section says "Node ≥ 20.11" (README.md:81).
- **Claude Code doesn't bring Node.** The native installer is the
  recommended install; the npm route needs Node 22+, but "the installed
  `claude` binary does not itself invoke Node"
  ([setup](https://code.claude.com/docs/en/setup)). So Node on PATH is
  a separate, unstated prerequisite.
- **What actually needs ≥ 20.11.** `import.meta.dirname` (the reason for
  the bump, CHANGELOG `[0.2.2]`) appears only in `test/*.test.mjs`
  (`cli.test.mjs:8`, `init-wizard.test.mjs:8`, `mcp-tools.test.mjs:114`).
  The runtime floor of `lib/` + `bin/` was not measured; keep 20.11 as
  the documented floor (Node 18 is EOL) rather than loosen it.
- **Dependency install** ([loading → Node.js package dependencies](https://code.claude.com/docs/en/plugins/loading.md#nodejs-package-dependencies)):
  Claude Code runs the *lockfile's* package manager (npm, for our
  `package-lock.json`, `lockfileVersion: 3`) from the user's PATH, with
  `--ignore-scripts`, frozen, in a separate folder (our `.npmrc` is not
  read), 60-second timeout; on failure the plugin still loads and
  `/plugin` shows a note. **No install** for relative-path plugins in a
  marketplace added from a local path (CONTRIBUTING's
  `claude plugin marketplace add ./` flow works only because the
  checkout already has `node_modules`). The lockfile has 120 packages,
  101 of them optional (`@anthropic-ai/sdk` and
  `@modelcontextprotocol/sdk` trees); the dev `node_modules` is 70 MB.
  The plugin never uses `@anthropic-ai/sdk` (the skill synthesises in
  the session). Install time against the 60 s limit was not measured.
- **Failure messages point the wrong way.**
  `bin/reviewlore.mjs:126-129` says "Run `npm install` in the
  toolkit's directory, or reinstall the Claude Code plugin" — reinstall
  can't help when npm itself is missing. `bin/commands/mcp.mjs:63-66`
  prints "Run: npm install @modelcontextprotocol/sdk", which is wrong
  advice for a plugin user and is invisible anyway (MCP stderr).
  SKILL.md:54-56 handles "Missing dependencies" but has no case for
  "node not found" or "Node too old".
- **`bin/` is a Claude Code component.** Files in a plugin's top-level
  `bin/` "are on the Bash tool's PATH while the plugin is enabled", and
  "claude.ai and Cowork don't install a plugin that has this directory"
  ([plugins reference → standard layout](https://code.claude.com/docs/en/plugins-reference);
  [platform support](https://claude.com/docs/plugins/platform-support):
  "Executables in a top-level `bin/` directory — Can't be installed" in
  Chat and Cowork). Side effect today: `reviewlore.mjs`,
  `fetch-pr-comments.mjs`, `pr-comments-to-skills.mjs` and
  `pr-comments-mcp.mjs` (all `chmod +x` with a node shebang) become
  bare commands in every Claude Code session of every repo.
- **Even without `bin/`, chat/Cowork are limited.** Local (command) MCP
  servers are ignored in Chat and load in Cowork only "when the Cowork
  session runs on your computer"; whether Cowork has Node and a shell
  for the skill was not verifiable from the docs.
- **Windows.** Native Windows uses Git Bash for the Bash tool if Git
  for Windows is installed, otherwise PowerShell; with Git Bash
  installed, the PowerShell tool is still on by default for claude.ai
  accounts and "Claude treats PowerShell as the primary shell"
  ([setup](https://code.claude.com/docs/en/setup),
  [tools reference](https://code.claude.com/docs/en/tools-reference.md)).
  SKILL.md:29 (`out="$(mktemp -t pr-feedback.XXXXXX)" && node … > "$out"
  && echo "$out"`) and SKILL.md:149 (`rm "$out"`) are POSIX-only.
  `${CLAUDE_PLUGIN_ROOT}` is substituted with forward slashes on
  Windows (`C:/Users/…`), which Node accepts. A skill using `!` inline
  shell injection with the default `shell: bash` fails outright on
  Windows without Git Bash ([skills](https://code.claude.com/docs/en/skills.md)).
- **Code paths.** `lib/` uses `path.join` for files; `split("/")` only on
  URLs (`lib/fetchers.mjs:27,48`), GitHub paths
  (`lib/renderers/_common.mjs:69`) and a cosmetic demo message
  (`bin/commands/generate.mjs:117`). `lib/cache.mjs:111` relies on
  `renameSync` over an existing file (atomic on POSIX; on Windows it
  can fail with `EPERM`/`EBUSY` if another process holds the file —
  unverified). `lib/github-client.mjs` spawns `gh`, `lib/git-info.mjs`
  spawns `git` — both resolve on Windows via PATHEXT (unverified).
- **CI.** `.github/workflows/ci.yml` and `release.yml` matrix:
  `os: [ubuntu-latest, macos-latest]` × Node 20/22/24. No Windows. All
  of `test/run-all.sh`, `scripts/check-pack.sh`, `smoke-test.sh`,
  `check-secrets.sh` are bash and need `jq`.
- **Timeouts.** The Bash tool's default timeout is 2 minutes; in an
  interactive session a command that hits it is *moved to the
  background*, not killed (killed only with
  `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1` or bare mode)
  ([tools reference](https://code.claude.com/docs/en/tools-reference.md)).
  SKILL.md gives Claude no guidance for that case (the brief's "killed"
  is only true in those modes). Long-fetch UX is covered in 12.

## Goals / Non-goals

**Goals:** a clear, actionable message for every missing prerequisite,
before any GitHub call; one skill command that works in bash, Git
Bash, PowerShell and cmd; Windows in CI; a plugin claude.ai/Cowork
will at least install; requirements documented where plugin users look.

**Non-goals:** bundling a Node runtime; a non-Node port; making the
skill work in claude.ai Chat (no shell there); GitHub Enterprise or
non-GitHub hosts.

## Options considered

1. **Docs only** (README + TROUBLESHOOTING). Cheap; users still hit
   raw `command not found` first.
2. **`!` dynamic-context preflight in SKILL.md** (`` !`node … doctor || true` ``).
   Runs before Claude reads the skill, but forces a shell: with
   `shell: bash` the skill fails entirely on Windows without Git Bash.
3. **Explicit preflight step + `doctor` subcommand + shell-neutral
   command** (Claude runs one plain `node "<path>" …` line with whatever
   shell it has; the CLI does the temp-file work). Works everywhere Node
   runs; the "node missing" case is recognised from the shell error.

**Chosen:** 3, plus the docs from 1. Move `bin/` → `cli/` in the same
release so claude.ai/Cowork can install the plugin.

## Design

**`reviewlore doctor [--json]`** (new, offline, no auth, no
network). Checks, each `{ id, ok, message, fix }`:
`node` (`process.versions.node` vs `engines.node` read from the
package's own `package.json`), `deps.octokit` and `deps.mcp`
(`import.meta.resolve` of `@octokit/rest` / `@modelcontextprotocol/sdk`),
`git` (spawn `git --version`), `repo` (git toplevel + GitHub remote
parsed by `detectRepoFromGit`; non-github.com host → "only github.com
is supported"), `corpus` (present / repo match / age). It does **not**
resolve or inspect tokens: auth is reported by the real command's
existing error. Exit 0 if all required checks pass, 1 otherwise. Help
and version paths unchanged. stdout = the report, stderr = nothing.

**Shell-neutral candidates.** New flag `candidates --save`: writes the
JSON to `mkdtemp(os.tmpdir()/reviewlore-)/candidates.json`
(mode 0600) and prints only that path on stdout. New
`candidates --discard <path>` deletes it, refusing any path not under a
`reviewlore-` temp dir. SKILL.md step 1 becomes:

```
node "${CLAUDE_PLUGIN_ROOT}/cli/reviewlore.mjs" doctor
node "${CLAUDE_PLUGIN_ROOT}/cli/reviewlore.mjs" candidates --save
```
Both lines are valid in bash, PowerShell and cmd. Step 5 uses
`--discard` instead of `rm`.

**Skill preflight text** (step 0, verbatim user-facing messages):
- shell says `node` not found / not recognized →
  "reviewlore needs Node.js 20.11 or newer on your PATH, and
  Claude Code doesn't include it. Install Node.js LTS from
  https://nodejs.org (or `brew install node`, or
  `winget install OpenJS.NodeJS.LTS`), restart Claude Code, then run
  this again." Stop.
- `doctor` reports old Node → same, with the found version.
- deps missing, plugin from GitHub marketplace → "The plugin's npm
  dependencies weren't installed. Claude Code installs them with npm
  when the plugin is installed, so npm must be on your PATH. Run
  `/plugin`, check the note on reviewlore, then reinstall it."
- deps missing, local-path marketplace → "Run `npm ci` in
  <plugin root>."
- not a GitHub repo → explain and stop (no fetch attempted).
The skill never inspects environment variables or credentials itself.

**`bin/` → `cli/` move.** `git mv bin cli`; keep file names. npm's
`bin` map keeps the same command names, so npm users see no change.
Old plugin versions keep working from their own cache dirs.

**MCP server message** (`cli/commands/mcp.mjs`): when the SDK is
missing, say "reviewlore's MCP server needs its npm
dependencies. If you installed the Claude Code plugin, reinstall it
(npm must be on PATH); otherwise run `npm install` in <root>."

**Trim plugin install weight (optional, measured first):** if the
plugin install is slow, move `@anthropic-ai/sdk` from
`optionalDependencies` to a lazily installed / documented optional
(`--llm` already loads it dynamically) — only if timing shows the 60 s
limit at risk.

## Implementation steps

1. `test/doctor.test.mjs` (hermetic: fake `package.json` engines,
   stubbed resolver, temp git repo with/without GitHub remote) → add
   `lib/doctor.mjs` (pure checks, returns report) → wire
   `doctor` in `bin/reviewlore.mjs` (help text, dispatch).
2. `candidates --save` / `--discard` with tests in `test/cli.test.mjs`
   (path printed, file 0600 on POSIX, discard refuses foreign paths).
3. Rewrite SKILL.md steps 1 and 5 and add step 0 (preflight messages);
   add a "if the command was moved to the background, wait for it and
   then read the printed path" line (details in 12).
4. Fix messages: `bin/reviewlore.mjs:126-129`,
   `bin/commands/mcp.mjs:63-66`.
5. Move `bin/` → `cli/`. Update: `package.json` (`bin` map, `files`
   `"bin"` → `"cli"`, `version` script `git add cli …`),
   `.claude-plugin/plugin.json` (`mcpServers.args`), SKILL.md,
   `scripts/update-version.js` targets, `scripts/check-pack.sh`
   REQUIRED (+ add `cli/commands/*`, `lib/doctor.mjs`; add `^bin/` to
   FORBIDDEN), `scripts/smoke-test.sh` (`./cli/$bin.mjs`, plus a
   `doctor --json` check), `scripts/record-demo.sh`,
   `scripts/validate-llm.sh`, `test/cli.test.mjs:9-11`,
   `test/init-wizard.test.mjs:9`, `test/mcp-tools.test.mjs:114`,
   `CLAUDE.md` layout + rules, `CONTRIBUTING.md` project-shape table,
   `.claude/rules/node-cli-patterns.md` ("anything under `cli/`"),
   `.claude/commands/release.md`. Leave `docs/audit-history.md` (history).
6. Root `CLAUDE.md` makes `claude plugin validate` warn: move developer
   guidance to `.claude/CLAUDE.md` (Claude Code loads it as project
   memory too) so `validate --strict` passes for 01.
7. CI: add `windows-latest` × Node 22 to `ci.yml` (and `release.yml`
   test job) with `shell: bash` (Git Bash on the runner), running
   `node --test test/` and the smoke test; install `jq` via
   `choco install jq` if absent (presence on the image unverified).
   Fix what breaks (expected: path assertions, `renameSync` EPERM,
   line endings — add `.gitattributes` `* text=auto eol=lf` for
   `*.mjs *.sh *.md`).
8. Docs (below). CHANGELOG.

## Tests & verification

- Unit: `doctor` checks (all hermetic, no token resolution, no
  network); `--save`/`--discard`; message text snapshots.
- CI: existing gates + Windows job; smoke runs `cli/` entry points
  from the packed tarball and `doctor --json`.
- Eval: no impact (`eval`, `eval:real` unchanged).
- Plugin eval: a `claude plugin eval` case
  ([plugin evals](https://code.claude.com/docs/en/plugin-evals.md))
  that hides `node` from PATH and grades that the skill stops with the
  Node message instead of retrying or improvising. Keep the skill
  description short (it is ~80 tokens/turn today; official listings
  flag ≥ 2,000) — the preflight text goes in the body, not the
  description.
- Manual matrix before release: macOS without Node on PATH (rename
  `node` via a PATH shim) → skill shows the Node message; GitHub
  marketplace install with npm hidden → `/plugin` note + skill deps
  message; Windows 11 with Git Bash, and without (PowerShell only) →
  skill completes on a repo with a committed corpus; `/mcp` connected;
  `claude plugin validate --strict .` passes; claude.ai **Upload
  plugin** accepts the zip (install only — usefulness in Cowork is an
  open question).

## Docs & changelog

README "Use it in Claude Code": a **Requirements** line — "Node.js
≥ 20.11 and npm on your PATH (Claude Code doesn't include Node);
GitHub repos only; Windows works with Git Bash or PowerShell."
TROUBLESHOOTING plugin section: "node not found", "dependencies not
installed", Windows notes, `doctor`. `docs/cli.md`: `doctor`,
`candidates --save/--discard`. CONTRIBUTING: local-path marketplace
needs `npm ci`; `cli/` layout. CHANGELOG `[Unreleased]`.

## Risks, compatibility & rollback

- `cli/` move: npm command names unchanged, but anyone invoking
  `node …/bin/…` by path (e.g. a hand-written MCP config pointing into
  a global install) breaks. Compatibility shims can't stay in `bin/`
  without re-creating the claude.ai/Cowork blocker, so document it in
  CHANGELOG instead. CONTRIBUTING's versioning rules treat output
  paths as public API, not entry-point paths; minor vs major is the
  owner's call.
- PowerShell quoting of `${CLAUDE_PLUGIN_ROOT}` paths with spaces: the
  double-quoted form works in all three shells; verify on a profile
  path with a space.
- Node installed via nvm/fnm may be missing from the PATH of a
  GUI-launched Claude Code (desktop app) — doctor can't run then; the
  "node not found" message covers it; mention in TROUBLESHOOTING.
- Rollback: revert the move commit and bump `version`.

## Cross-cutting checks

- **Credentials:** `doctor` never resolves tokens or reads env vars;
  skill text keeps "never look for credentials".
- **Privacy:** `--save` file is 0600 in a private temp dir and
  discarded at the end; same data as today's `mktemp` file.
- **Determinism:** `doctor` output order fixed; candidates unchanged.
- **Deps:** none added (`import.meta.resolve` is built in).
- **stdout/stderr:** report/path on stdout; nothing else.
- **Windows:** primary target of this plan.
- **Plugin vs CLI:** `doctor` useful for both; CLI paths unchanged.

## Success metrics

- 0 raw `command not found` / stack traces in the manual matrix; every
  prerequisite failure ends in one of the scripted messages.
- CI green on ubuntu, macOS and Windows.
- `claude plugin validate --strict .` passes; claude.ai accepts the
  upload (no "can't be installed").
- Skill completes on Windows (Git Bash and PowerShell-only) in ≤ the
  same number of Claude turns as on macOS.

## Open questions for the owner

1. Is `cli/` the name you want (vs `src/bin`, `scripts/`)? It's
   user-visible only in paths.
2. Treat the `bin/` → `cli/` path change as minor or major?
3. Should `@anthropic-ai/sdk` stay an optional dependency (installed
   for every plugin user) or become documented opt-in for `--llm`?
4. Is a Cowork listing worth pursuing before someone confirms Node and a
   shell are available in Cowork sessions?
