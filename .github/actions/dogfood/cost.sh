#!/usr/bin/env bash
set -euo pipefail
cap=$(awk -v d="$CAP_USD" 'BEGIN { printf "%d", d * 100 + 0.5 }')
report=$(find .ocra/sessions -name report.json -type f -newer "$RUNNER_TEMP/ocra-review-start" 2>/dev/null | head -n 1 || true)
if [ -n "$report" ] && cents=$(jq -e '((.usage.costUsd // 0) * 100) | ceil' "$report" 2>/dev/null) &&
  [[ "$cents" =~ ^[0-9]+$ ]]; then
  source="report"
elif [ -n "$report" ]; then
  cents=$cap
  source="unreadable report, counted at the cap"
elif [ -z "$REVIEW_OUTCOME" ] || [ "$REVIEW_OUTCOME" = "skipped" ]; then
  cents=0
  source="no review ran"
else
  cents=$cap
  source="no report, counted at the cap"
fi
jq -n --argjson cents "$cents" --arg source "$source" --arg pr "$PULL_REQUEST" --arg head "$HEAD_SHA" \
  '{costUsd: ($cents / 100), source: $source, pullRequest: $pr, head: $head}' > "$RUNNER_TEMP/ocra-cost.json"
echo "name=ocra-cost-$RUN_ID-$RUN_ATTEMPT-c$cents" >> "$GITHUB_OUTPUT"
echo "Recorded $(awk -v c="$cents" 'BEGIN { printf "$%.2f", c / 100 }') ($source)." >> "$GITHUB_STEP_SUMMARY"
