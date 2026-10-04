#!/usr/bin/env bash
set -euo pipefail
case "$SOURCE" in
  vertex) ;;
  openrouter)
    allowed=true
    if [ "$SWITCH" != on ]; then
      allowed=false
      reason="reviews are off (OCRA_REVIEW is '$SWITCH')"
    elif [ -z "$OPENROUTER_API_KEY" ]; then
      echo "::error::model-source openrouter needs the OPENROUTER_API_KEY secret"
      exit 1
    else
      left=$FREE_LEFT
      if [[ "$left" =~ ^[0-9]+$ ]] && [ "$left" -lt "$FREE_MIN_REQUESTS" ]; then
        allowed=false
        reason="the free model quota is spent ($left request(s) left) until 00:00 UTC"
      fi
    fi
    echo "allowed=$allowed" >> "$GITHUB_OUTPUT"
    {
      echo "### ocra dogfood on the free model"
      echo
      echo "Model router/$FREE_MODEL, at most $FREE_MAX_TASKS review tasks; free requests left today: ${left:-not reported}."
      echo
      if [ "$allowed" = true ]; then echo "Review allowed."; else echo "**No review:** $reason."; fi
    } >> "$GITHUB_STEP_SUMMARY"
    if [ "$allowed" != true ]; then echo "::notice title=No ocra review::$reason"; fi
    exit 0
    ;;
  *)
    echo "::error::model-source must be vertex or openrouter, got '$SOURCE'"
    exit 1
    ;;
esac
cents() {
  if ! [[ "$1" =~ ^[0-9]+(\.[0-9]{1,2})?$ ]]; then
    echo "::error::not a dollar amount: '$1'"
    exit 1
  fi
  awk -v d="$1" 'BEGIN { printf "%d", d * 100 + 0.5 }'
}
usd() { awk -v c="$1" 'BEGIN { printf "$%.2f", c / 100 }'; }
budget=$(cents "$BUDGET_USD")
daily=$(cents "$DAILY_USD")
cap=$(cents "$CAP_USD")
# ocra stops running review tasks at its limit, but what they spend
# between two reports and their steps in progress can still pass
# it. Half the cap again covers that with room to spare.
reserve=$((cap * 3 / 2))

listing=$(gh api --paginate "repos/$REPOSITORY/actions/artifacts?per_page=100" \
  --jq '.artifacts[] | select(.name | startswith("ocra-cost-")) | "\(.created_at[0:10]) \(.name)"')
today=$(date -u +%F)
# A name the steps below did not write counts as a full reservation.
read -r spent spent_today runs < <(printf '%s\n' "$listing" |
  awk -v today="$today" -v reserve="$reserve" '
    NF < 2 { next }
    $2 ~ /^ocra-cost-[0-9]+-[0-9]+-[cr][0-9]+$/ {
      split($2, part, "-")
      key = part[3] "-" part[4]
      if (substr(part[5], 1, 1) == "c") { done[key] = substr(part[5], 2) + 0; doneDay[key] = $1 }
      else { held[key] = substr(part[5], 2) + 0; heldDay[key] = $1 }
      next
    }
    { spent += reserve; runs++; if ($1 == today) spentToday += reserve }
    END {
      for (key in done) { spent += done[key]; runs++; if (doneDay[key] == today) spentToday += done[key] }
      for (key in held) if (!(key in done)) { spent += held[key]; runs++; if (heldDay[key] == today) spentToday += held[key] }
      printf "%d %d %d\n", spent, spentToday, runs
    }')

allowed=true
if [ "$SWITCH" != on ]; then
  allowed=false
  reason="reviews are off (OCRA_REVIEW is '$SWITCH')"
elif [ $((spent + reserve)) -gt "$budget" ]; then
  allowed=false
  reason="the budget of $(usd "$budget") is spent: $(usd "$spent") over $runs review(s), and one more may cost $(usd "$reserve")"
elif [ "$spent_today" -ge "$daily" ]; then
  allowed=false
  reason="today's $(usd "$daily") is spent ($(usd "$spent_today")); reviews start again tomorrow (UTC)"
fi
echo "allowed=$allowed" >> "$GITHUB_OUTPUT"
echo "reserve=$reserve" >> "$GITHUB_OUTPUT"
{
  echo "### ocra dogfood budget"
  echo
  echo "Spent $(usd "$spent") of $(usd "$budget") over $runs review(s), $(usd "$spent_today") of today's $(usd "$daily")."
  echo
  if [ "$allowed" = true ]; then
    echo "Review allowed, capped at $(usd "$cap")."
  else
    echo "**No review:** $reason."
  fi
} >> "$GITHUB_STEP_SUMMARY"
# The summary is not in the log; a skipped review says why there too,
# so a green check that posted nothing explains itself.
if [ "$allowed" != true ]; then echo "::notice title=No ocra review::$reason"; fi
