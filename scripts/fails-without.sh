#!/usr/bin/env bash
# Usage: scripts/fails-without.sh <test file or vitest filter> <source file>...
# Checks that a test fails without the change it tests (AGENTS.md: a fix is
# not done until its test fails without it). Puts each source file back as
# it is at the base (BASE, default: the merge base with origin/main; a file
# new since then is removed), rebuilds, runs the test, and restores the
# files on every exit path. Exits 0 when the test fails there on an
# assertion; 1 when it passes, fails only because it cannot load, or no
# test ran (scripts/lib/fails-without.mjs).
set -euo pipefail
test="${1:?usage: scripts/fails-without.sh <test> <source file>...}"
shift
[ "$#" -gt 0 ] || { echo "name at least one source file" >&2; exit 2; }
root="$(git rev-parse --show-toplevel)"
cd "$root"
base="${BASE:-$(git merge-base HEAD origin/main)}"
saved="$(mktemp -d)"
restore() {
  for file in "$@"; do
    if [ -e "$saved/$file" ]; then /bin/cp -f "$saved/$file" "$file"; fi
  done
  /bin/rm -rf "$saved"
  npm run build --silent >/dev/null 2>&1 || true
}
trap 'restore "$@"' EXIT
for file in "$@"; do
  mkdir -p "$saved/$(dirname "$file")"
  /bin/cp -f "$file" "$saved/$file"
  if git cat-file -e "$base:$file" 2>/dev/null; then
    git show "$base:$file" > "$file"
  else
    /bin/rm -f "$file"
  fi
done
npm run build --silent >/dev/null 2>&1 || echo "note: the build fails without the change; the test result below may be that"
status=0
npx vitest run "$test" >"$saved/test.log" 2>&1 || status=$?
node scripts/fails-without.mjs "$status" "$saved/test.log"
