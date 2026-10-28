# Node CLI conventions

These rules apply to anything under `cli/` and the libraries they call.

The entry points live in `cli/`, not `bin/`: a Claude Code plugin's
top-level `bin/` is put on the Bash tool's PATH while the plugin is
enabled, and claude.ai / Cowork won't install a plugin that has one. The
pack check refuses a `bin/` directory.

## stdout is for data, stderr is for chrome

- All progress messages, prompts, error text, and summaries → `stderr`
  (`process.stderr.write`).
- Only the actual artifact (machine-readable output) goes to `stdout`.
- This lets users pipe `reviewlore fetch ... > out.json` and
  `reviewlore generate ... --dry-run --summary > report.md` without
  needing to filter chrome out of the stream.

## Exit codes

- Return numeric exit codes from the `main()` async function; the bin
  entry calls `process.exit(code)` at the end.
- `0` = success, `1` = user error (bad flags, missing input), other
  non-zero values for upstream failures (e.g., GitHub 5xx).

## No shebangs other than `#!/usr/bin/env node`

The entry point `cli/reviewlore.mjs` starts with `#!/usr/bin/env node`
and is executable; files in `cli/commands/` are modules it imports. All use
`.mjs`.
Every file is executable (`chmod +x`). The `files:` whitelist in
`package.json` ships them as-is; npm wires the `bin:` map at install time.

## Don't add CLI argument-parsing libraries

`lib/args.mjs` is intentionally tiny and dependency-free. Resist the urge
to pull in `yargs`/`commander`/`mri` for this. If a real need emerges
(subcommands, completions), revisit then.

## Help/version must work without auth

`--help` and `--version` must succeed without `GITHUB_TOKEN` set and
without any network calls. The smoke test enforces this against a real
tarball install — keep the help/version checks above any auth or fetch
logic in `main()`.
