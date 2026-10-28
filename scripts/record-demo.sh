#!/usr/bin/env bash
# Record a reproducible asciinema demo of the toolkit's core flow.
#
# Produces docs/demo.cast (an asciinema v2 recording) that can be:
#   - played locally:  asciinema play docs/demo.cast
#   - uploaded:        asciinema upload docs/demo.cast
#   - embedded in the README via the resulting asciinema.org URL
#   - converted to a GIF:  agg docs/demo.cast docs/demo.gif
#
# Requirements: asciinema (brew install asciinema), and the toolkit
# linked or installed. The recorded session itself needs nothing — it
# uses --demo, which runs against the bundled fixture with no token.
#
# Usage:
#   bash scripts/record-demo.sh         # records docs/demo.cast
#   DEMO_PLAY=1 bash scripts/record-demo.sh   # just run the script body
#                                             # without recording (preview)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

CAST="docs/demo.cast"
INNER="$ROOT/scripts/_demo-body.sh"

# The actual on-screen script. Kept in a temp file so asciinema records
# it as a single non-interactive session with realistic pacing.
cat > "$INNER" <<'BODY'
#!/usr/bin/env bash
set -e
type_cmd() { printf '$ %s\n' "$1"; sleep 0.6; }
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

clear 2>/dev/null || printf '\033[2J\033[H' 2>/dev/null || true
echo "# reviewlore — 60-second demo"
echo "# Turn a repo's PR review history into rules your AI tools read."
sleep 1.5
echo

type_cmd "npx -y reviewlore generate --demo"
node "$ROOT/cli/reviewlore.mjs" generate --demo 2>&1 | sed -n '1,40p'
sleep 2
echo
echo "# ^ Generated rules from a bundled fixture — no token, no setup."
sleep 1.5
echo
echo "# On a real repo it's one command:"
type_cmd "cd ~/code/your-project && reviewlore run"
sleep 1
echo "#   → auto-detects owner/repo from git remote"
echo "#   → uses your gh CLI token (or GITHUB_TOKEN)"
echo "#   → writes .claude/rules/  (or --format cursor|copilot|html|...)"
sleep 2
echo
echo "# Done. Review the diff, delete false positives, commit."
sleep 1.5
BODY
chmod +x "$INNER"

if [[ "${DEMO_PLAY:-}" == "1" ]]; then
  echo "Preview mode (no recording):" >&2
  bash "$INNER"
  rm -f "$INNER"
  exit 0
fi

if ! command -v asciinema >/dev/null; then
  echo "Error: asciinema not installed. Install with: brew install asciinema" >&2
  echo "(Or preview the demo body without recording: DEMO_PLAY=1 bash scripts/record-demo.sh)" >&2
  rm -f "$INNER"
  exit 1
fi

mkdir -p docs
rm -f "$CAST"
asciinema rec "$CAST" \
  --title "reviewlore demo" \
  --idle-time-limit 2 \
  --command "bash $INNER"

rm -f "$INNER"
echo
echo "✅ Recorded $CAST"
echo "   Play:    asciinema play $CAST"
echo "   Upload:  asciinema upload $CAST"
echo "   To GIF:  agg $CAST docs/demo.gif   (https://github.com/asciinema/agg)"
