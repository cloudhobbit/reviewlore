# Troubleshooting

Common errors and how to resolve them, organised by the symptom you'd see.

---

## Claude Code plugin

### The skill stops before fetching anything

It runs `reviewlore doctor` first and stops on any `FAIL` line. Ask
Claude to show you the full `doctor` output; each failing line has a fix.

- **`node` not found / Node too old** — the plugin runs on your own
  Node.js (20.11 or newer); Claude Code doesn't ship one. Install Node.js
  LTS and restart Claude Code.
- **`deps.octokit` FAIL** — Claude Code installs the plugin's npm
  dependencies at install time, which needs npm on your PATH. Fix PATH,
  then reinstall the plugin from `/plugin`. (A repo with a committed
  corpus doesn't need this dependency.)
- **`repo` FAIL** — run Claude Code from a clone of a github.com
  repository. GitHub Enterprise, GitLab and Bitbucket aren't supported
  yet.

### Claude doesn't pick up the skill

Check the plugin is installed and enabled with `/plugin`, then invoke the
skill explicitly: `/reviewlore:learn-from-reviews`. Asking in
your own words ("learn our conventions from PR reviews") usually works
too, once the plugin is enabled.

### The skill stops with "No GitHub token found"

The skill never looks for credentials itself. Either run `gh auth login`
in a terminal (the toolkit picks up the `gh` token), export
`GITHUB_TOKEN` before starting Claude Code, or have a teammate commit a
corpus with `reviewlore publish-corpus` — the skill then needs
no token at all.

### The skill proposes few or no rules

Expected on small repos and on repos where one person does most of the
reviewing: a rule needs at least 2 PRs and 2 reviewers. Ask Claude for a
longer window ("use 12 months") or to include single-reviewer
conventions, and it will flag which rules fall below the default bar.

### The `reviewlore` MCP tools don't appear

Run `/mcp` to see server status. The plugin starts the server with the
plugin's own copy of the toolkit; if it failed, reinstall the plugin so
its dependencies are installed again.

---

## Setup / authentication

### `No GitHub token found. Either pass --token, set GITHUB_TOKEN, or run `gh auth login`.`

You need an authenticated GitHub session. **Easiest path**: if you have
the GitHub CLI installed:

```bash
gh auth login          # one-time interactive setup
# then re-run your toolkit command — it'll pick up the gh token
```

**Alternative**: create a Personal Access Token (PAT):

1. Go to https://github.com/settings/tokens (classic) or
   https://github.com/settings/personal-access-tokens (fine-grained).
2. **For public repos**: `public_repo` scope is enough.
3. **For private repos**: `repo` scope (classic) or read-only `Contents`
   + `Pull requests` (fine-grained).
4. Copy the token, then either:
   ```bash
   export GITHUB_TOKEN=ghp_xxx          # session-scoped
   # OR add to your shell profile (.bashrc / .zshrc) for persistence
   ```
   Or pass per-command: `--token ghp_xxx`.

The toolkit's token-resolution order is: `--token` flag > `GITHUB_TOKEN`
env var > `gh auth token` output.

### `401 Unauthorized` from GitHub mid-fetch

Your token is invalid or expired.

```bash
# Verify the token works:
gh auth status                            # for gh-CLI tokens
curl -H "Authorization: token $GITHUB_TOKEN" https://api.github.com/user   # for PATs
```

If invalid: regenerate (PAT) or re-login (`gh auth login`).

### `404 Not Found` for a repo I know exists

Most likely your token doesn't have access to that repo. Private repos
require the `repo` scope on a PAT (or the equivalent on a fine-grained
token). Also check the spelling of `--owner` and `--repo`.

### Copilot doesn't seem to use the exported rules

Path-specific instructions (`.github/instructions/*.instructions.md`)
apply to Copilot code review and the coding agent. Check that custom
instructions are enabled for code review in the repository's Copilot
settings, and that the PR touches files matching the rule's `applyTo`.

### Claude Code Review ignores `review-pr-feedback.md`

`REVIEW.md` includes (`@review-pr-feedback.md`) are honoured only when
Claude Code Review reads `REVIEW.md` from a protected branch, and at most
eight are read. Merge the export to your default branch first.

### GitHub Enterprise: "No token for <host>"

reviewlore uses only a token meant for that host. Run
`gh auth login --hostname <host>`, or set `GH_ENTERPRISE_TOKEN`
(GitHub Enterprise Server) or `GH_TOKEN` (GHE.com). A github.com
`GITHUB_TOKEN` is deliberately not sent to an enterprise server.

### GitLab: "No token for gitlab.com"

Create a personal access token with the `read_api` scope (GitLab →
Preferences → Access tokens) and export it as `GITLAB_TOKEN`. Public
projects need one too: gitlab.com lists merge requests anonymously but
answers 401 for their comments. A GitHub
token is never used for GitLab. For a self-managed GitLab, also set
`GITLAB_HOST=<host>`: `GITLAB_TOKEN` alone is only sent to gitlab.com, so
a cloned repository can't point it at another server. If the host name
doesn't contain "gitlab", pass `--provider gitlab --host <host>` too.

### GitHub Enterprise: certificate errors ("unable to get local issuer certificate")

Your server uses an internal certificate authority. Point Node at it:
`NODE_EXTRA_CA_CERTS=/path/to/ca.pem reviewlore run`.

### "origin is …: … isn't GitHub" / "isn't an owner/repo path"

The repository's `origin` is GitLab, Bitbucket or another host that isn't
GitHub, or an SSH alias reviewlore can't resolve. For an alias, pass
`--host <hostname>`; GitLab and Bitbucket aren't supported yet.

### "Hit GitHub's API rate limit; it resets at …"

The token's hourly budget (5,000 requests; 1,000 per repository for the
Actions `GITHUB_TOKEN`) is spent — usually by other tools sharing the
token: a six-month first fetch takes from a few dozen requests on a
quiet repo to about 1,000 on one as busy as pnpm. With `--cache` (and always in `run`/`candidates`, unless
`--no-cache`), progress is saved: re-run after the reset time and it
continues where it stopped.

### "GitHub secondary rate limit: waiting …" during a fetch

reviewlore reads comment lists 6 at a time and backs off when GitHub asks
it to. If it happens often (a shared token, a busy GitHub Enterprise
host), lower the parallelism: `REVIEWLORE_FETCH_CONCURRENCY=2`.

### A fetch was interrupted

Re-run the same command. Progress is saved in
`~/.reviewlore/<owner>__<repo>.partial.json` while a fetch runs and is
resumed when the next fetch's window is covered by it (and it is less
than a week old); it is deleted once the fetch completes.

### `403 Forbidden` mid-run

If the message doesn't mention a rate limit, the token lacks access or
scope — see above.

---

## `--llm` synthesis errors

### `The --llm flag requires @anthropic-ai/sdk to be installed.`

```bash
npm install -g @anthropic-ai/sdk
# OR install locally if you cloned the repo:
npm install @anthropic-ai/sdk
```

### `ANTHROPIC_API_KEY is required for --llm.`

Get one from https://console.anthropic.com/settings/keys. Then:

```bash
export ANTHROPIC_API_KEY=sk-ant-xxx
# OR per-command:
--api-key sk-ant-xxx
```

### A few clusters error during `--llm` synthesis

This is expected and non-fatal. Failed clusters fall back to the
heuristic rendering, with an HTML comment in the generated file
explaining what happened. Re-run later or fix the underlying issue
(rate limits, model outage). To force a re-attempt, pass `--force` to
overwrite the partial files.

---

## Output / generation issues

### "Kept 0 clusters" with default thresholds

The defaults (`--min-occurrences 3 --min-authors 2`) are tuned for
precision over recall on active repos. On a quiet repo or a short
window, they may filter out everything. Try:

```bash
--min-occurrences 2 --min-authors 2   # gentler
--months 12                            # bigger window
--threshold 0.25                       # looser clustering
```

### Too many clusters, including noise

Tighten instead:

```bash
--min-occurrences 5 --min-authors 3    # only strong consensus
--engine semantic --threshold 0.35     # tighter similarity
```

### Generated rules don't match what I'd expect

Rules are *evidence-based*: by default a rule needs 3 occurrences (distinct
reviewer + PR pairs) from at least 2 reviewers. If a rule you'd expect
is missing, look at what was extracted:

```bash
reviewlore candidates > feedback.json
# The strongest clusters, single comments included (--limit 1000 for
# more). If your rule's comments aren't there, they were filtered or not
# recognised as review requests.
```

Common reasons a rule won't surface:
- **Reviewers use different vocabulary** for the same concept ("avoid
  `any`" vs "tighten the type"). The heuristic engine is bag-of-words;
  use `--engine semantic` for TF-IDF weighting or `--llm` for
  semantic-aware synthesis. The Claude Code plugin handles this best: Claude
  merges differently worded requests before applying the threshold.
- **Most instances were resolved** (PR author replied "fixed"). The
  signal filter drops resolved threads on the theory that the rule
  is already enforced in the code. To see all instances, you'd need to
  turn off the `dropResolvedThreads` option of `applySignals` in
  `lib/signals.mjs`.
- **One verbose reviewer wrote it three times in one PR.** Counted as
  one (author, PR) tuple to prevent inflation. You'd need a different
  metric.

### `Error: --target path does not exist`

The path you passed doesn't resolve to an existing directory.
Double-check with `ls -d <path>`. Common gotchas: tilde expansion
(`~/code/repo` works in shells but not in some flags — pass an
absolute path to be safe), trailing slashes, case sensitivity on
Linux.

### `Warning: --target is not a git repository`

Non-fatal. The tool works in any directory but the generated rules are
most useful when committed alongside the code they describe.

### `Skipped N existing file(s) (pass --force to overwrite)`

By design: the tool will not silently clobber rule files you may have
hand-edited. Pass `--force` to regenerate them.

---

## MCP server issues (`reviewlore mcp`)

### `@modelcontextprotocol/sdk is required.`

```bash
npm install -g @modelcontextprotocol/sdk
```

### MCP tools say "No review history for owner/repo yet"

The server still answers with the repo's `.claude/rules/` files, but has
no comments to search. Run `/reviewlore:learn-from-reviews` (it fetches
the history), or from the repository:

```bash
reviewlore fetch --cache
```

The server reads `~/.reviewlore/<owner>__<repo>.json` or the
repository's committed `.reviewlore-corpus.json`, whichever is newer.

### MCP tools say "Couldn't tell which GitHub repository …"

The project directory isn't a clone with a github.com `origin` and has
no committed corpus. Pass `owner` and `repo` to the tool, or open Claude
Code in the repository.

### MCP server starts but Claude Code doesn't see the tools

The Claude Code plugin registers the server for you. Without the plugin:

```bash
claude mcp list                        # see registered servers
claude mcp add reviewlore -- npx -y reviewlore mcp
```

Before v0.3 the server crashed on startup; if you registered it then,
upgrade the package.

---

## Other

### My fetch is slow

On a busy 12-month repo, the first fetch can take 30+ seconds. Speed-ups:

- Use `--cache` so subsequent runs are incremental.
- Use `--months 3` instead of 6 or 12 for a smaller window.

### How do I uninstall / start over?

```bash
# Remove the cache (if you used --cache)
rm -rf ~/.reviewlore/

# Remove generated rules from a target repo
rm <target>/.claude/rules/pr-feedback-*.md
rm <target>/.claude/.reviewlore-state.json

# Uninstall the npm package / the plugin
npm uninstall -g reviewlore
# plugin: run /plugin in Claude Code and uninstall reviewlore there
```

All files this tool creates are local to your machine and the target
repo. No remote state.

### How much does `--llm` cost?

For a single run with 10–30 clusters:
- Input tokens per cluster: ~500 (cluster summary)
- Output tokens per cluster: ~200 (synthesised rule)
- System prompt: ~350 tokens (too short to be prompt-cached)
- Low-effort thinking adds a few hundred output tokens per cluster

At `claude-sonnet-5-5` pricing ($2 / $10 per million input / output
tokens), that's roughly $0.02–$0.20 per full re-generation. Treat
this as an estimate; your Anthropic console shows the actual usage.

### Where do I get help?

- Inline docs: `reviewlore --help`, and `--help` on `fetch`,
  `generate` and `mcp`.
- [CLI reference](./docs/cli.md) and [how it works](./docs/how-it-works.md).
- File an issue at https://github.com/cloudhobbit/reviewlore/issues
  with the command you ran, the output (token redacted), and your Node version.
