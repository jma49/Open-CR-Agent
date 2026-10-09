#!/usr/bin/env bash
# The Action's review step (action.yml): runs the installed ocra on the pull
# request, then sets the Action's outputs (action-outputs.mjs). Its inputs
# arrive only as environment variables, never interpolated into the script,
# so pull request text cannot inject shell code: OCRA_MAIN (the installed
# CLI), OCRA_PR, OCRA_ARGS, OCRA_SARIF, OCRA_FAIL_ON_CONCERNS.
# GitHub's options for a bash step; no -u: bash 3.2 reads an empty array as unset.
set -eo pipefail
if [ -z "${OCRA_PR:-}" ]; then
  echo "::error::ocra review runs on pull_request events"
  exit 2
fi
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Split on whitespace, across lines, without glob expansion against the
# checkout.
read -r -d '' -a extra <<< "${OCRA_ARGS:-}" || true
mkdir -p "$RUNNER_TEMP/ocra"
export OCRA_SARIF_FILE="$RUNNER_TEMP/ocra/ocra.sarif"
rm -f "$OCRA_SARIF_FILE"
# Last, so they win over a --format or --output in args.
if [ "${OCRA_SARIF:-}" = "true" ]; then extra+=(--format sarif --output "$OCRA_SARIF_FILE"); fi
# Run ids start with the UTC second the run started: the outputs come from
# the session report of this run, not an earlier one.
OCRA_STARTED="$(date -u +%Y%m%dT%H%M%SZ)"
export OCRA_STARTED
# Bash does not pass a cancellation's SIGINT/SIGTERM on to a child it waits
# for, so ocra runs in the background and gets them forwarded: it then stops,
# writes its partial report and publishes nothing.
node "$OCRA_MAIN" review --pr "$OCRA_PR" --publish "${extra[@]}" &
pid=$!
trap 'kill -INT "$pid" 2>/dev/null' INT TERM
code=0
while kill -0 "$pid" 2>/dev/null; do
  wait "$pid" && code=0 || code=$?
done
OCRA_EXIT_CODE="$code" node "$here/action-outputs.mjs"
if [ "$code" -eq 1 ] && [ "${OCRA_FAIL_ON_CONCERNS:-}" != "true" ]; then code=0; fi
exit "$code"
