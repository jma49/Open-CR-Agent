#!/usr/bin/env bash
# Downloads the finished cycles of the free golden eval (eval-free.yml keeps
# each as an artifact named <label>-<workflow run> for 90 days) and prints
# their trend. Runs already downloaded are skipped. Needs gh, logged in, and
# a build (npm run build).
#
#   bash scripts/eval-free-download.sh [dir] [artifact name pattern]
#   bash scripts/eval-free-download.sh .ocra/eval/free 'free-*@feat-review-wrap-up-turn-*'
set -euo pipefail
dir="${1:-.ocra/eval/free}"
pattern="${2:-free-*}"
repo="${REPO:-jma49/Open-CR-Agent}"
mkdir -p "$dir"
# The workflow runs that kept an artifact, from the artifact list; a run's
# artifact name ends in its id.
gh api --paginate "repos/$repo/actions/artifacts?per_page=100" \
  --jq '.artifacts[] | select(.expired | not) | select(.name | startswith("free-")) | "\(.workflow_run.id) \(.name)"' |
  while read -r run name; do
    if [ -e "$dir/$name" ]; then continue; fi
    # shellcheck disable=SC2053 # the pattern is a glob on purpose
    if [[ "$name" != $pattern ]]; then continue; fi
    echo "Downloading $name" >&2
    gh run download "$run" --repo "$repo" --pattern "$pattern" --dir "$dir" ||
      echo "Could not download the artifacts of run $run" >&2
  done
node packages/eval/dist/main.js trend "$dir"
