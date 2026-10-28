#!/usr/bin/env bash
# Validates the contents of the npm tarball that would be published.
# - Confirms required files (cli/, lib/, README, LICENSE, CHANGELOG)
# - Blocks forbidden files (test/, .github/, .claude/, node_modules, .env)
# - Reports tarball size
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if ! command -v jq &>/dev/null; then
  echo "Error: jq is required (brew install jq)." >&2
  exit 1
fi

echo "Running 'npm pack --dry-run --json'..."
PACK_JSON="$(npm pack --dry-run --json 2>/dev/null)"

REQUIRED=(
  "cli/reviewlore.mjs"
  "cli/commands/fetch.mjs"
  "cli/commands/generate.mjs"
  "cli/commands/mcp.mjs"
  "cli/commands/export.mjs"
  "lib/github-client.mjs"
  "lib/fetchers.mjs"
  "lib/filters.mjs"
  "lib/output.mjs"
  "lib/args.mjs"
  "lib/doctor.mjs"
  "lib/scratch.mjs"
  "lib/rate-limit.mjs"
  "lib/progress.mjs"
  "lib/instructions.mjs"
  "lib/github-errors.mjs"
  "lib/slim.mjs"
  "lib/rule-files.mjs"
  "lib/export.mjs"
  "lib/review-index.mjs"
  "lib/globs.mjs"
  "lib/index-builder.mjs"
  "lib/rules-manifest.mjs"
  "lib/rule-status.mjs"
  "lib/github-host.mjs"
  "lib/raw.mjs"
  "lib/providers/index.mjs"
  "lib/providers/gitlab.mjs"
  "lib/fixtures/demo-candidates.json"
  "lib/normalize.mjs"
  "lib/patterns.mjs"
  "lib/cluster.mjs"
  "lib/extract.mjs"
  "lib/signals.mjs"
  "lib/similarity.mjs"
  "lib/llm.mjs"
  "lib/cache.mjs"
  "lib/diff.mjs"
  "lib/mcp-tools.mjs"
  "lib/skill-writer.mjs"
  "lib/renderers/index.mjs"
  "lib/renderers/claude.mjs"
  "lib/renderers/cursor.mjs"
  "lib/renderers/copilot.mjs"
  "lib/renderers/contributing.mjs"
  "lib/renderers/json.mjs"
  "lib/renderers/html.mjs"
  "lib/renderers/aider.mjs"
  "lib/renderers/agents.mjs"
  "lib/renderers/windsurf.mjs"
  "lib/renderers/_common.mjs"
  "lib/presets.mjs"
  "lib/config.mjs"
  "lib/init-wizard.mjs"
  "lib/git-info.mjs"
  "lib/corpus.mjs"
  "lib/secret-scan.mjs"
  "lib/fixtures/demo-typescript.json"
  "README.md"
  "TROUBLESHOOTING.md"
  "LICENSE"
  "CHANGELOG.md"
  "package.json"
)

FORBIDDEN_PATTERNS=(
  "^bin/"  # a plugin's bin/ goes on PATH and blocks claude.ai / Cowork installs
  "^test/"
  "^scripts/"
  "^docs/"
  "^\\.github/"
  "^\\.claude/"
  "^node_modules/"
  "^\\.env"
  "\\.tgz$"
  "pr-comments-.*\\.json$"
)

FILES="$(echo "$PACK_JSON" | jq -r '.[0].files[].path')"
SIZE_KB="$(echo "$PACK_JSON" | jq -r '.[0].size' | awk '{printf "%.1f", $1/1024}')"
UNPACKED_KB="$(echo "$PACK_JSON" | jq -r '.[0].unpackedSize' | awk '{printf "%.1f", $1/1024}')"

EXIT=0
echo
echo "Checking required files..."
for f in "${REQUIRED[@]}"; do
  if grep -qxF "$f" <<<"$FILES"; then
    echo "  ✓ $f"
  else
    echo "  ✗ MISSING: $f"
    EXIT=1
  fi
done

echo
echo "Checking for forbidden files..."
FORBIDDEN_FOUND=0
for pat in "${FORBIDDEN_PATTERNS[@]}"; do
  if MATCHES="$(echo "$FILES" | grep -E "$pat" || true)" && [[ -n "$MATCHES" ]]; then
    echo "  ✗ Forbidden ($pat):"
    echo "$MATCHES" | sed 's/^/      /'
    FORBIDDEN_FOUND=1
    EXIT=1
  fi
done
[[ $FORBIDDEN_FOUND -eq 0 ]] && echo "  ✓ No forbidden files"

echo
echo "Tarball size:    ${SIZE_KB} KB"
echo "Unpacked size:   ${UNPACKED_KB} KB"
echo "File count:      $(echo "$FILES" | wc -l | tr -d ' ')"

if [[ $EXIT -ne 0 ]]; then
  echo
  echo "❌ check-pack failed"
  exit 1
fi
echo
echo "✅ check-pack passed"
