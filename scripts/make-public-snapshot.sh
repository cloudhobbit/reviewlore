#!/usr/bin/env bash
# Builds the squashed public snapshot (CONTRIBUTING.md, "First public
# release"): one parentless commit holding <ref>'s files, on a local
# `public-main` branch. Never checks anything out and never pushes; it
# prints the push command instead.
#
#   bash scripts/make-public-snapshot.sh --email <you>@users.noreply.github.com \
#     [--name "Your Name"] [--ref main] [--message "reviewlore 0.3.0"] \
#     [--branch public-main] [--force] [--skip-tests]
#
# Before committing, an export of the snapshot is checked:
#   - credential patterns (lib/secret-scan.mjs) in every file, except the
#     known false positives in ALLOWED_HITS;
#   - no email that authored the private history, and no home-directory
#     path, appears in any file;
#   - npm ci, the test suite and check-pack pass (skip with --skip-tests).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

REF=main
BRANCH=public-main
NAME="$(git log -1 --format=%an "$REF" 2>/dev/null || true)"
EMAIL=""
MESSAGE=""
FORCE=0
TESTS=1

# Paths left out of the snapshot (git pathspecs). Empty: everything in
# <ref> is public.
EXCLUDE=()

# "<path> <label>" pairs the secret scan may report: documentation and
# tests of the patterns themselves, and Netlify preview QR codes (a JWT
# holding only a public URL) in public bot comments.
ALLOWED_HITS=(
  "docs/plans/11-privacy-and-trust.md private_key_pem"
  "test/secret-scan.test.mjs private_key_pem"
  "eval/real/comments.json jwt"
)

while [[ $# -gt 0 ]]; do
  case "$1" in
    --email) EMAIL="$2"; shift 2 ;;
    --name) NAME="$2"; shift 2 ;;
    --ref) REF="$2"; shift 2 ;;
    --message) MESSAGE="$2"; shift 2 ;;
    --branch) BRANCH="$2"; shift 2 ;;
    --force) FORCE=1; shift ;;
    --skip-tests) TESTS=0; shift ;;
    -h|--help) sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

if [[ -z "$EMAIL" ]]; then
  echo "Error: --email is required (your GitHub noreply address, so no personal email goes public)." >&2
  exit 1
fi
if [[ "$EMAIL" != *@users.noreply.github.com ]]; then
  echo "Warning: $EMAIL isn't a GitHub noreply address; it will be public in the commit." >&2
fi
git rev-parse --verify -q "$REF^{commit}" >/dev/null || { echo "Error: $REF isn't a commit." >&2; exit 1; }
if git rev-parse --verify -q "refs/heads/$BRANCH" >/dev/null && [[ $FORCE -eq 0 ]]; then
  echo "Error: branch $BRANCH exists; pass --force to replace it." >&2
  exit 1
fi
VERSION="$(git show "$REF:package.json" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).version))')"
MESSAGE="${MESSAGE:-reviewlore $VERSION}"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# The tree: <ref>'s, minus EXCLUDE, built in a private index.
export GIT_INDEX_FILE="$WORK/index"
git read-tree "$REF"
if [[ ${#EXCLUDE[@]} -gt 0 ]]; then
  git rm -r -q --cached --ignore-unmatch -- "${EXCLUDE[@]}"
fi
TREE="$(git write-tree)"
unset GIT_INDEX_FILE

EXPORT="$WORK/export"
mkdir "$EXPORT"
git archive "$TREE" | tar -x -C "$EXPORT"
echo "Snapshot of $REF: $(git ls-tree -r --name-only "$TREE" | wc -l | tr -d ' ') files, tree ${TREE:0:12}" >&2

FAIL=0

echo "Checking for credentials..." >&2
HITS="$(node --input-type=module -e '
  import { readFileSync } from "node:fs";
  import { join } from "node:path";
  import { pathToFileURL } from "node:url";
  const { scanText } = await import(pathToFileURL(join(process.argv[1], "lib/secret-scan.mjs")).href);
  const files = readFileSync(0, "utf-8").split("\n").filter(Boolean);
  for (const f of files) {
    let text;
    try { text = readFileSync(join(process.argv[1], f), "utf-8"); } catch { continue; }
    for (const label of new Set(scanText(text).map((h) => h.label))) console.log(`${f} ${label}`);
  }
' "$EXPORT" < <(git ls-tree -r --name-only "$TREE"))"
while IFS= read -r hit; do
  [[ -z "$hit" ]] && continue
  allowed=0
  for a in "${ALLOWED_HITS[@]}"; do [[ "$hit" == "$a" ]] && allowed=1; done
  if [[ $allowed -eq 0 ]]; then
    echo "  ✗ $hit" >&2
    FAIL=1
  fi
done <<<"$HITS"

echo "Checking for private-history emails and home paths..." >&2
while IFS= read -r email; do
  [[ -z "$email" || "$email" == "$EMAIL" || "$email" == *noreply* ]] && continue
  if grep -rIlF -- "$email" "$EXPORT" >/dev/null; then
    echo "  ✗ an author email of $REF's history appears in: $(grep -rIlF -- "$email" "$EXPORT" | sed "s|$EXPORT/||" | head -5 | tr '\n' ' ')" >&2
    FAIL=1
  fi
done < <(git log --format='%ae%n%ce' "$REF" | sort -u)
# Placeholder users (the eval data's paths are pseudonymised to /Users/user/).
HOMES="$(grep -rIoE -- '/(Users|home)/[A-Za-z][A-Za-z0-9_.-]*/' "$EXPORT" \
  | grep -vE ':/(Users|home)/(user|runner|me|you|username|name|runneradmin)/$' || true)"
if [[ -n "$HOMES" ]]; then
  echo "  ✗ home-directory paths: $(sed "s|$EXPORT/||" <<<"$HOMES" | sort -u | head -5 | tr '\n' ' ')" >&2
  FAIL=1
fi

if [[ $TESTS -eq 1 && $FAIL -eq 0 ]]; then
  echo "Installing and testing the snapshot..." >&2
  (cd "$EXPORT" && npm ci --silent --no-audit --no-fund && bash test/run-all.sh >/dev/null && bash scripts/check-pack.sh >/dev/null) \
    || { echo "  ✗ npm ci, the tests or check-pack failed in the snapshot" >&2; FAIL=1; }
fi

if [[ $FAIL -ne 0 ]]; then
  echo "❌ Snapshot not created." >&2
  exit 1
fi

COMMIT="$(GIT_AUTHOR_NAME="$NAME" GIT_AUTHOR_EMAIL="$EMAIL" GIT_COMMITTER_NAME="$NAME" GIT_COMMITTER_EMAIL="$EMAIL" \
  git commit-tree "$TREE" -m "$MESSAGE")"
git branch -f "$BRANCH" "$COMMIT"
echo "✅ $BRANCH → ${COMMIT:0:12} (\"$MESSAGE\", $NAME <$EMAIL>, no parents)" >&2
echo "Push it to the empty public repository with:" >&2
echo "  git push git@github.com:cloudhobbit/reviewlore.git $BRANCH:main" >&2
