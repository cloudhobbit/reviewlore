---
description: Run the full pre-publish audit suite (tests + pack + secrets + smoke)
---

# /audit

Run every check that `prepublishOnly` runs, so the user catches problems
before tagging a release.

## Steps

1. `npm test` — Node test suite (38+ tests).
2. `npm run check:pack` — validates `npm pack` contents: required files
   present, forbidden files absent, tarball size sensible.
3. `npm run check:secrets` — scans shipped files for credential patterns
   (GitHub PATs, AWS keys, private keys, Anthropic keys, Slack tokens).
4. `npm run smoke` — packs a real tarball, extracts to /tmp, installs
   deps, runs both bins with `--version` and `--help`. Catches issues
   that only show after `npm pack` (missing files in `files:`, broken
   bin shebangs).

Stop and report on the first failure. Don't auto-fix without asking —
the user may want to see the raw output first.

## When to run

- Before every `/release`.
- After any change to `package.json` `files:` or `bin:` arrays.
- After adding a new `lib/` module (verify it's in the `check-pack.sh`
  REQUIRED list).
