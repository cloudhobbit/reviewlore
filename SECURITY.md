# Security policy

## Reporting a vulnerability

Please report security issues privately through GitHub's **"Report a
vulnerability"** button on this repository's Security tab (private
vulnerability reporting), not in a public issue. Include the version
(`reviewlore --version`), what you ran, and what happened. You'll get an
acknowledgement within a week.

Especially relevant here:

- anything that could print, log or persist a GitHub token or Anthropic
  API key;
- a committed corpus or generated rule that leaks a credential the secret
  scanner should have redacted;
- the MCP server reading files outside its cache or the user's project.

## Supported versions

Only the latest release receives fixes.
