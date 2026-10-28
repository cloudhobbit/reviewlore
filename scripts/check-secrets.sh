#!/usr/bin/env bash
# Scans files that would be shipped via npm pack for high-confidence
# credential patterns. Blocks publish if anything matches.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if ! command -v jq &>/dev/null; then
  echo "Error: jq is required (brew install jq)." >&2
  exit 1
fi

echo "Computing shipped file list..."
FILES="$(npm pack --dry-run --json 2>/dev/null | jq -r '.[0].files[].path')"

# High-confidence patterns only. Each is a literal regex applied via grep -E.
# Keep in sync with SECRET_PATTERNS in lib/secret-scan.mjs.
PATTERNS=(
  # GitHub tokens (ghp_/gho_/ghu_/ghs_/ghr_) and fine-grained PATs
  'gh[pousr]_[A-Za-z0-9]{36,}'
  'github_pat_[A-Za-z0-9_]{60,}'
  # GitLab, npm
  'glpat-[A-Za-z0-9_-]{20,}'
  'npm_[A-Za-z0-9]{36}'
  # AWS
  'AKIA[0-9A-Z]{16}'
  'aws_secret_access_key[[:space:]]*=[[:space:]]*[A-Za-z0-9/+=]{40}'
  # Google, Stripe, Atlassian, JWT
  'AIza[0-9A-Za-z_-]{35}'
  '[sr]k_live_[0-9A-Za-z]{24,}'
  'ATATT[A-Za-z0-9_=-]{20,}'
  'eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}'
  # Generic API keys
  'api[_-]?key[[:space:]]*[:=][[:space:]]*["'\''`][A-Za-z0-9_\-]{32,}["'\''`]'
  # Private keys (any PEM type, incl. PKCS#8 and encrypted)
  '-----BEGIN [A-Z ]*PRIVATE KEY-----'
  # Slack tokens
  'xox[abprs]-[A-Za-z0-9-]{10,}'
  # Anthropic
  'sk-ant-[A-Za-z0-9_\-]{20,}'
)

FOUND=0
echo
echo "Scanning ${#PATTERNS[@]} patterns across shipped files..."
while IFS= read -r file; do
  [[ -f "$file" ]] || continue
  for pat in "${PATTERNS[@]}"; do
    # Report file, line numbers and the pattern — never the matched text,
    # or this audit would itself leak the secret into CI logs.
    if LINES="$(grep -E -n -e "$pat" -- "$file" 2>/dev/null | cut -d: -f1 | paste -sd, - || true)" && [[ -n "$LINES" ]]; then
      echo "  ✗ $file (line $LINES) matches: $pat"
      FOUND=1
    fi
  done
done <<< "$FILES"

if [[ $FOUND -ne 0 ]]; then
  echo
  echo "❌ check-secrets failed — remove the matches above before publishing."
  exit 1
fi
echo "  ✓ No credential patterns found"
echo
echo "✅ check-secrets passed"
