# Never log, echo, or persist the Anthropic API key

The `--api-key` flag and `ANTHROPIC_API_KEY` env var carry credentials
that must never appear in stdout, stderr, error messages, telemetry,
generated rule files, or test fixtures.

**Why:** Anthropic API keys grant billable access to the user's account.
A leaked key in a log file, CI output, or committed test fixture is a
credential leak that can persist in `git log` history forever — and
attackers actively scrape GitHub for `sk-ant-` patterns. Same rule as
`no-token-logging.md` but for the LLM path.

**How to apply:**
1. When constructing the Anthropic client (`lib/llm.mjs`), read the key
   once and discard the reference (don't pass it through any object
   that's later serialised).
2. Error messages must say *"set ANTHROPIC_API_KEY"* — never echo the
   key value itself, even partially redacted.
3. Test fixtures and example invocations in docs must use placeholder
   keys like `sk-ant-xxx`, never real-looking strings.
4. `scripts/check-secrets.sh` matches the `sk-ant-[A-Za-z0-9_\-]{20,}`
   pattern across all shipped files and blocks publish on a match.
   Don't add bypasses.
5. The synthesised rule output may end up committed into the target
   repo's `.claude/rules/`. The LLM is instructed to NOT include
   reviewer names, PR numbers, or quotes in rule fields — but verify
   the prompt + parsing if you modify `lib/llm.mjs`.
