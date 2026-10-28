# Demo

A reproducible terminal recording of the toolkit's core flow, for the
README and launch material.

## Watch it

Once recorded + uploaded, embed the asciinema badge in the README:

```markdown
[![asciicast](https://asciinema.org/a/<ID>.svg)](https://asciinema.org/a/<ID>)
```

## Record it yourself

```bash
# 1. Install asciinema (one-time)
brew install asciinema        # macOS
# pip install asciinema       # everywhere else

# 2. Record — produces docs/demo.cast
bash scripts/record-demo.sh

# 3. Play it back
asciinema play docs/demo.cast

# 4. (Optional) upload for a shareable URL
asciinema upload docs/demo.cast

# 5. (Optional) convert to an animated GIF for README/social
#    https://github.com/asciinema/agg
agg docs/demo.cast docs/demo.gif
```

## Preview the script without recording

```bash
DEMO_PLAY=1 bash scripts/record-demo.sh
```

This runs the exact on-screen sequence (against the bundled `--demo`
fixture — no GitHub token, no network) so you can sanity-check the
content before committing a recording.

## What the demo shows

1. **`reviewlore generate --demo`** — the full pipeline against a
   bundled fixture, printing generated Claude rules to stdout. Zero
   setup: no token, no target repo, nothing to clean up.
2. **The one-command real-repo flow** — `reviewlore run` from
   inside a cloned project, with the auto-detection and zero-auth
   corpus path called out.
3. **The review-and-commit step** — reinforcing that the output is
   evidence to curate, not rules to blindly trust.

## Why a fixture and not a real repo

The recording must be deterministic and runnable by anyone (including
CI and reviewers without a GitHub token). `--demo` guarantees identical
output every time, so the cast never goes stale or leaks a real repo's
review comments.

For a recording against a *real* repo (e.g. for a specific launch
post), run `reviewlore run --dry-run` (it prints the summary) against a
public repo you have a token for, and record that manually — but keep
`docs/demo.cast` as the canonical, reproducible one.
