#!/usr/bin/env bash
# One-shot validation of the --llm synthesis path against the cached
# pnpm corpus. Proves (or refutes) the central claim that LLM mode turns
# heuristic social-pattern noise into real, generalised rules.
#
# Requires ANTHROPIC_API_KEY in the environment. Costs ~$0.05-0.20 in
# Anthropic tokens (7 clusters at low effort).
#
# Usage:
#   ANTHROPIC_API_KEY=sk-ant-... bash scripts/validate-llm.sh
#
# Output: writes both heuristic and LLM versions side-by-side under
#   examples/real-repos/pnpm/{heuristic,llm}/ for a committed before/after.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

CORPUS="$HOME/.reviewlore/pnpm__pnpm.json"
if [[ ! -f "$CORPUS" ]]; then
  echo "Error: pnpm corpus not found at $CORPUS" >&2
  echo "Re-fetch with: reviewlore fetch --owner pnpm --repo pnpm --months 6 --cache" >&2
  exit 1
fi

if [[ -z "${ANTHROPIC_API_KEY:-}" ]]; then
  echo "Error: ANTHROPIC_API_KEY is required." >&2
  echo "Run: ANTHROPIC_API_KEY=sk-ant-... bash scripts/validate-llm.sh" >&2
  exit 1
fi

if [[ ! -d node_modules/@anthropic-ai/sdk ]]; then
  echo "Installing @anthropic-ai/sdk (optional dep needed for --llm)..." >&2
  npm install @anthropic-ai/sdk --no-save --registry=https://registry.npmjs.org/ >&2
fi

HEUR="examples/real-repos/pnpm/heuristic"
LLM="examples/real-repos/pnpm/llm"
rm -rf "$HEUR" "$LLM"
mkdir -p "$HEUR" "$LLM"

echo "=== Heuristic (baseline) ===" >&2
node cli/reviewlore.mjs generate "$CORPUS" \
  --target "$HEUR" --format claude,html,contributing \
  --preset team-of-50 --force >&2

echo >&2
echo "=== LLM-synthesised ===" >&2
node cli/reviewlore.mjs generate "$CORPUS" \
  --target "$LLM" --format claude,html,contributing \
  --preset team-of-50 --llm --force >&2

echo >&2
echo "✅ Side-by-side written:" >&2
echo "   Heuristic: $HEUR/CONTRIBUTING.md" >&2
echo "   LLM:       $LLM/CONTRIBUTING.md" >&2
echo >&2
echo "Compare the 'Recurring review feedback' sections to see whether" >&2
echo "LLM synthesis turned social patterns into real rules / marked them" >&2
echo "INCOHERENT." >&2
