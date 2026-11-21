#!/usr/bin/env bash
# The Action's learn step (action.yml): drafts learnings with the installed
# ocra and opens them as a pull request, whose address becomes the proposal
# output. Its inputs arrive only as environment variables, never
# interpolated into the script, so comment text cannot inject shell code:
# OCRA_MAIN (the installed CLI), OCRA_LEARN, OCRA_PR, OCRA_OWN_TOKEN,
# OCRA_ARGS. action.yml execs it, so the runner's cancellation signals reach
# its trap.
# GitHub's options for a bash step; no -u: bash 3.2 reads an empty array as unset.
set -eo pipefail
case "${OCRA_LEARN:-}" in
  mine) change=() ;;
  remember)
    if [ -z "${OCRA_PR:-}" ]; then
      echo "::error::learn: remember runs on a comment on a pull request (issue_comment) or on pull_request events"
      exit 2
    fi
    change=(--pr "$OCRA_PR")
    ;;
  *)
    echo "::error::learn must be mine or remember"
    exit 2
    ;;
esac
read -r -d '' -a extra <<< "${OCRA_ARGS:-}" || true
# A pull request opened with the workflow's own token starts no workflows,
# so required checks would never report on it: a person merges it instead.
if [ "${OCRA_OWN_TOKEN:-}" = "true" ]; then
  echo "::notice::The pull request is left for a person to merge: one opened with the workflow's own token starts no checks. Pass a GitHub App's token as github-token to merge it once its checks pass."
  extra+=(--require-review)
fi
out="$RUNNER_TEMP/ocra-learn.out"
# Bash does not pass a cancellation's SIGINT/SIGTERM on to a child it waits
# for, so ocra runs in the background and gets them forwarded.
node "$OCRA_MAIN" learn "$OCRA_LEARN" "${change[@]}" --propose "${extra[@]}" > "$out" &
pid=$!
trap 'kill -INT "$pid" 2>/dev/null' INT TERM
code=0
while kill -0 "$pid" 2>/dev/null; do
  wait "$pid" && code=0 || code=$?
done
cat "$out"
# ocra prints the pull request's address alone on a line, or nothing when it
# kept no learning; anything else is not passed on as an output.
url="$(grep -m1 -E '^https://[^[:space:]]+$' "$out" || true)"
echo "proposal=$url" >> "$GITHUB_OUTPUT"
exit "$code"
