#!/usr/bin/env bash
# The Action's reply step (action.yml): answers the comment that started the
# workflow with the installed ocra. Its inputs arrive only as environment
# variables, never interpolated into the script, so comment text cannot
# inject shell code: OCRA_MAIN (the installed CLI), OCRA_PR, OCRA_COMMENT,
# OCRA_INLINE, OCRA_ARGS. action.yml execs it, so the runner's cancellation
# signals reach its trap.
# GitHub's options for a bash step; no -u: bash 3.2 reads an empty array as unset.
set -eo pipefail
if [ -z "${OCRA_PR:-}" ] || [ -z "${OCRA_COMMENT:-}" ]; then
  echo "::error::reply runs on a comment on a pull request (issue_comment or pull_request_review_comment)"
  exit 2
fi
change=(--pr "$OCRA_PR" --comment "$OCRA_COMMENT")
if [ "${OCRA_INLINE:-}" = "true" ]; then change+=(--inline); fi
read -r -d '' -a extra <<< "${OCRA_ARGS:-}" || true
# Bash does not pass a cancellation's SIGINT/SIGTERM on to a child it waits
# for, so ocra runs in the background and gets them forwarded.
node "$OCRA_MAIN" reply "${change[@]}" "${extra[@]}" &
pid=$!
trap 'kill -INT "$pid" 2>/dev/null' INT TERM
code=0
while kill -0 "$pid" 2>/dev/null; do
  wait "$pid" && code=0 || code=$?
done
exit "$code"
