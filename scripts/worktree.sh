#!/usr/bin/env bash
# Usage: scripts/worktree.sh <branch> [base]
# A worktree next to this checkout (../ocra-wt-<branch with / as ->), on a
# new branch from base (default: origin/main, fetched first), installed and
# built, so its tests run at once. Packages import each other through
# dist/, so a worktree without a build tests against nothing, or against
# another checkout's stale build.
set -euo pipefail
branch="${1:?usage: scripts/worktree.sh <branch> [base]}"
base="${2:-origin/main}"
root="$(git rev-parse --show-toplevel)"
dir="$(dirname "$root")/ocra-wt-${branch//\//-}"
git -C "$root" fetch --quiet origin
git -C "$root" worktree add --quiet -b "$branch" "$dir" "$base"
cd "$dir"
npm ci --ignore-scripts --no-audit --no-fund --loglevel=error >&2
npm run build --silent >&2
echo "$dir"
