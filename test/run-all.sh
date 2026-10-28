#!/usr/bin/env bash
# Test orchestrator. Runs all Node tests in test/*.test.mjs.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if ! command -v node &>/dev/null; then
  echo "Error: node is not installed." >&2
  exit 1
fi

if [[ ! -d node_modules ]]; then
  echo "node_modules not found — running npm install..."
  npm install --silent
fi

echo "Running Node test suite..."
node --test --test-reporter=spec test/*.test.mjs
echo
echo "✅ All tests passed."
