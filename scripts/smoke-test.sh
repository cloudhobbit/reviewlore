#!/usr/bin/env bash
# Packs a real tarball, extracts it to /tmp, installs deps, and exercises both
# CLIs with --version and --help. Catches packaging issues that won't show up
# in the dev tree (missing files in `files`, wrong shebang, broken bin paths).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "Packing tarball..."
TARBALL="$(npm pack --silent 2>/dev/null | tail -n 1)"
mv "$TARBALL" "$TMP/"
TARBALL="$TMP/$TARBALL"

echo "Extracting to $TMP/install..."
mkdir -p "$TMP/install"
cd "$TMP/install"
tar -xzf "$TARBALL"
cd package

echo "Installing dependencies..."
# The extracted tarball has no .npmrc, so pin the public registry here too:
# a global/corporate npm config would otherwise decide what gets installed.
npm install --omit=dev --silent --registry=https://registry.npmjs.org/

for cmd in "" fetch generate mcp export; do
  echo
  echo "=== reviewlore $cmd ==="

  echo "  --version"
  OUT="$(node ./cli/reviewlore.mjs $cmd --version)"
  if ! grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+' <<<"$OUT"; then
    echo "  ✗ --version did not return semver: $OUT"
    exit 1
  fi
  echo "    → $OUT"

  echo "  --help"
  OUT="$(node ./cli/reviewlore.mjs $cmd --help)"
  if ! grep -q 'Usage:' <<<"$OUT"; then
    echo "  ✗ --help missing Usage: block"
    exit 1
  fi
  echo "    → OK ($(echo "$OUT" | wc -l | tr -d ' ') lines)"
done

# doctor from the installed tarball must find its own dependencies. The
# extracted package isn't a git repo, so the repo check fails (exit 1);
# only the node and deps.* checks are asserted.
echo
echo "=== reviewlore doctor --json ==="
OUT="$(node ./cli/reviewlore.mjs doctor --json || true)"
if ! echo "$OUT" | node -e '
  const r = JSON.parse(require("fs").readFileSync(0, "utf-8"));
  const bad = r.checks.filter((c) => ["node", "deps.octokit", "deps.mcp"].includes(c.id) && !c.ok);
  if (bad.length) { console.error(bad.map((c) => c.id + ": " + c.message).join("\n")); process.exit(1); }
'; then
  echo "  ✗ doctor reported missing Node or dependencies in the installed package"
  exit 1
fi
echo "    → OK"

# End-to-end exercise for `reviewlore generate`. Catches packaging issues
# that --help/--version don't (missing lib files in `files:`, broken imports
# only triggered on real input). Uses a fixture with 3 reviewer comments
# from 3 authors expressing the same recurring rule, so default thresholds
# produce exactly one rule file.
echo
echo "=== end-to-end: reviewlore generate against fixture ==="
FIXTURE="$TMP/fixture.json"
TARGET="$TMP/target-repo"
mkdir -p "$TARGET"
cat > "$FIXTURE" <<'JSON'
{
  "meta": { "owner": "x", "repo": "y", "since": "2025-01-01", "months_back": 6 },
  "issue_comments": [
    { "author": "alice", "pr_number": 1, "html_url": "u1", "body": "Please avoid any types." },
    { "author": "bob",   "pr_number": 2, "html_url": "u2", "body": "Don't use any types." },
    { "author": "carol", "pr_number": 3, "html_url": "u3", "body": "We shouldn't add any types." }
  ],
  "review_comments": [],
  "review_submissions": []
}
JSON

if ! node ./cli/reviewlore.mjs generate "$FIXTURE" --target "$TARGET" > /dev/null; then
  echo "  ✗ reviewlore generate exited non-zero on fixture"
  exit 1
fi
if ! ls "$TARGET/.claude/rules/pr-feedback-"*.md > /dev/null 2>&1; then
  echo "  ✗ no skill file written to $TARGET/.claude/rules/"
  exit 1
fi
RULE_FILE="$(ls "$TARGET/.claude/rules/pr-feedback-"*.md | head -n 1)"
if ! grep -q '^# ' "$RULE_FILE"; then
  echo "  ✗ generated rule file missing its title heading"
  exit 1
fi
if grep -q '^type: feedback$' "$RULE_FILE"; then
  echo "  ✗ generated rule file still has pre-0.3 frontmatter"
  exit 1
fi
echo "    → wrote $(basename "$RULE_FILE") (format valid)"

echo
echo "✅ smoke-test passed"
