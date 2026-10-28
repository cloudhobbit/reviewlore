# CLAUDE.md — developer & agent guide for reviewlore

This file orients Claude (and humans) working on this package.

## Layout

```
cli/                         # CLI entry points (not bin/: see node-cli-patterns.md)
  reviewlore.mjs    # the CLI: run / candidates / doctor / precedents / init / publish-corpus,
                             # dispatches fetch / generate / mcp / export to cli/commands/
  commands/                  # fetch.mjs, generate.mjs, mcp.mjs, export.mjs — export main(argv)
.claude-plugin/              # Claude Code plugin + marketplace manifests (repo root
                             # is the plugin; version synced by update-version.js)
skills/learn-from-reviews/   # plugin skill: Claude synthesises rules from `candidates`
skills/review-my-changes/    # plugin skill: pre-PR check from `precedents`
lib/                         # All logic, no I/O wiring
  args.mjs                   # tiny dependency-free flag parser
  github-client.mjs          # Octokit constructor; token per GitHub host
  github-host.mjs            # github.com / GHE.com / GHES: host, API URL, precedence
  providers/                 # index.mjs (openFetcher), gitlab.mjs (GitLab REST v4)
  filters.mjs                # date range, dedup
  fetchers.mjs               # comments (REST) + reviews (GraphQL, REST fallback), resume
  rate-limit.mjs             # retries / rate limits via Octokit's request hook
  progress.mjs               # one-line fetch progress + ETA (stream injected)
  github-errors.mjs          # actionable messages for GitHub failures
  output.mjs                 # JSON writers (single file + per-month)
  normalize.mjs              # strip markdown, drop noise (bots, praise)
  patterns.mjs               # classify sentences (prohibition/prescription/...)
  cluster.mjs                # greedy centroid clustering (engine-pluggable), polarity-split
  extract.mjs                # extractCandidates → buildClusters → filterClusters
  signals.mjs                # plain-issue / PR-author / resolved-thread filters, weights
  similarity.mjs             # clustering engines (jaccard, TF-IDF)
  skill-writer.mjs           # render & write .claude/rules/pr-feedback-*.md
  renderers/                 # other output formats (agents, cursor, copilot, …)
  cache.mjs, corpus.mjs      # ~/.reviewlore cache (+ partial fetches), committed corpus
  slim.mjs                   # output-identical slim corpus + its serialisation
  llm.mjs                    # --llm rewrite via the Claude API
  mcp-tools.mjs              # MCP tools: repo resolution, index memo, definitions
  review-index.mjs           # BM25 search + path feedback over rules and comments
  index-builder.mjs          # child process that indexes big caches for the server
  globs.mjs                  # the `paths:` glob dialect (shared with eval/skill)
  doctor.mjs                 # offline readiness checks (`reviewlore doctor`)
  scratch.mjs                # private temp file for `candidates --save/--discard`
  instructions.mjs           # history stats + existing instruction files (candidates)
  raw.mjs                    # `candidates --raw`: whole comments, any language, budgeted
  rule-files.mjs, export.mjs # parse .claude/rules/pr-feedback-*.md; `reviewlore export`
  rules-manifest.mjs         # .claude/reviewlore-rules.json: generated-rule records
  rule-status.mjs            # `reviewlore rules status` checks
eval/                        # not shipped: synthetic eval, real/ (labelled comments),
                             # skill/ (rule-file checker for the gallery)
scripts/                     # not shipped, dev-only
  check-pack.sh              # validates `npm pack` contents
  check-secrets.sh           # scans shipped files for credential patterns
  smoke-test.sh              # packs tarball, installs, runs --help/--version
  make-public-snapshot.sh     # squashed public-repo commit, checked; never pushes
  update-version.js          # syncs VERSION const into cli/ on `npm version`
test/                        # not shipped, dev-only
  *.test.mjs                 # Node test runner suites
  run-all.sh                 # orchestrator
.claude/
  rules/                     # enforceable rules (read by Claude in this repo)
  commands/                  # slash commands (/release, /audit, /generate-skills-from-prs)
  settings.local.json        # permission whitelist (gitignored)
.github/workflows/
  ci.yml                     # on push/PR: tests + audits, matrix
  release.yml                # on v* tag: tests then npm publish + provenance
```

## One CLI, one plugin

`reviewlore` is the single CLI. Its stages (`fetch`, `generate`,
`mcp`) live in `cli/commands/` and stay usable on their own — e.g. feed
JSON from any source into `generate`. The old command names are shims
over the same modules; keep them working.

The repo root is also a Claude Code plugin (`.claude-plugin/`). Its skill
(`skills/learn-from-reviews/`) calls `reviewlore candidates` and
has Claude synthesise rules in the user's session; `plugin.json` registers
the MCP server. Changing the `candidates` JSON shape means updating the
skill in the same PR. Run `claude plugin validate .` after touching
either manifest.

## Architecture rules

1. **`lib/` never exits or prints.** No `process.exit`, no console writes;
   fetch progress goes to a stream `cli/` passes in (`lib/progress.mjs`). Argument parsing,
   console output and exit codes live in `cli/`. (Renderers, the cache and
   the corpus do write files from `lib/`.)
2. **stdout = artifact, stderr = chrome.** See `.claude/rules/node-cli-patterns.md`.
3. **No new runtime deps.** Only `@octokit/rest` (plus the optional
   `@anthropic-ai/sdk` and `@modelcontextprotocol/sdk`). The flag parser,
   the tokenizer, the clusterer — all hand-rolled and tiny. If you reach for
   a dep, justify it in the PR and update `check-pack.sh` REQUIRED list.
4. **Help/version must work without auth.** Smoke test enforces this.

## Adding a new feature

1. Read the relevant rule files in `.claude/rules/`.
2. Write the logic as a pure function in `lib/`.
3. Write a test in `test/<module>.test.mjs` first (Node test runner).
4. Wire it into the relevant `cli/` entry.
5. Update `lib/...` exports if needed.
6. Run `npm test`.
7. If the new file is shipped, add it to `scripts/check-pack.sh` REQUIRED.
8. Update CHANGELOG.md under `[Unreleased]`.

## Releasing

Use `/release` (see `.claude/commands/release.md`). The short version:

```bash
npm test && npm run audit:all && npm run eval && npm run eval:real && npm run eval:skill
# move [Unreleased] → new version heading in CHANGELOG.md, commit
npm version patch   # or minor / major; syncs cli/ VERSION + plugin manifest
git push && git push --tags
```

The `release.yml` workflow takes over: matrix tests, then
`npm publish --provenance --access public`.

## Heuristic generator — when to revisit

`lib/patterns.mjs`, `lib/normalize.mjs` and `lib/cluster.mjs` are
intentionally conservative. Measure every change with
`node eval/run-real-eval.mjs --verbose` (tune on the dev split, report the
held-out split). If real-world output is too noisy or too sparse:

- **Too noisy** (false positives): tighten patterns (require more
  context), raise default `minOccurrences`, raise default `threshold`.
- **Too sparse** (false negatives): add new patterns to `PATTERNS` (e.g.
  "this would be better as", "I'd suggest", "consider X"), lower default
  threshold (but watch for cluster merging too aggressively).
- **Wrong topics**: improve `STOPWORDS`, add domain-specific stemming.

Before changing defaults, add a test that captures the failure mode and
check the real-data eval doesn't regress.

## Where the LLM comes in

Two paths, both optional — the CLI must keep working offline with no key:

- **Plugin skill (preferred).** `skills/learn-from-reviews/SKILL.md` has
  Claude, in the user's own session, merge and judge the output of
  `reviewlore candidates`. No API key, and it fixes the
  heuristic's paraphrase blindness.
- **`--llm`** (`lib/llm.mjs`): rewrites heuristic clusters via the Claude
  API with `ANTHROPIC_API_KEY`. See `.claude/rules/api-key-handling.md`.

## Things to avoid

- Don't add a global config file. Keep all behaviour driven by flags +
  env vars; this tool is a one-shot, not a long-running service.
- Don't write directly to `process.stdout` from `lib/` modules.
- Don't make the default path depend on an LLM or an API key.
- Don't echo or persist the GitHub token. (See `.claude/rules/no-token-logging.md`.)
