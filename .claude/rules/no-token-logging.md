# Never log, echo, or persist the GitHub token

The `--token` flag and `GITHUB_TOKEN` env var carry credentials that must
never appear in stdout, stderr, error messages, telemetry, generated JSON
output, or test fixtures.

**Why:** GitHub PATs grant write access to repos. A token leaked into a
log file, CI output, or committed test fixture is a credential leak that
can persist in `git log` history forever. The same applies to user-provided
Anthropic API keys in any future LLM integration.

**How to apply:**
1. When constructing the Octokit client (`lib/github-client.mjs`), read the
   token once and discard the reference (do not pass it through any object
   that's later serialized).
2. Error messages must say *"check your GITHUB_TOKEN"* — never echo the
   token value itself, even partially redacted.
3. Test fixtures and example invocations in docs must use placeholder
   tokens like `ghp_xxx`, never real-looking strings.
4. The `scripts/check-secrets.sh` audit blocks publish if any shipped file
   matches a credential pattern — don't bypass it.
