#!/usr/bin/env bash
set -euo pipefail
quota='429|quota|rate.?limit|free-models-per-day'
failed=0 spent=0 total=0
if [ -n "$REPORT" ] && [ -f "$REPORT" ]; then
  read -r total failed spent < <(jq -r --arg re "$quota" '
    [.tasks[]?] as $t
    | [$t[] | select(.status != "completed")] as $f
    | "\($t | length) \($f | length) \([$f[] | select((.error // "") | test($re; "i"))] | length)"' "$REPORT")
fi
{
  echo
  echo "ocra exited ${EXIT_CODE:-without an exit code}: $total task(s), $failed not completed, $spent of them on the free quota."
} >> "$GITHUB_STEP_SUMMARY"
if [ "$spent" -gt 0 ] && [ "$spent" -eq "$total" ]; then
  echo "::notice title=No ocra review::the free model quota is spent until 00:00 UTC; every review task failed on it"
elif [ "$spent" -gt 0 ]; then
  echo "::notice title=Incomplete ocra review::the free model quota ran out during the review ($spent of $total tasks); it resets at 00:00 UTC"
elif [ "${EXIT_CODE:-2}" != 0 ] && [ "${EXIT_CODE:-2}" != 1 ]; then
  echo "::warning title=ocra review::ocra exited ${EXIT_CODE:-without an exit code}; see the review step's log"
fi
