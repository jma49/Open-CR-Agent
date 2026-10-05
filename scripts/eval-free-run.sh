#!/usr/bin/env bash
# The free golden eval of eval-free.yml: the ocra-eval of the checkout under
# test (EVAL_ROOT) reviews the cycle's cases with that checkout's CLI, against
# the cases in GOLDEN_DIR, and stops by itself when the quota refuses one. To
# leave RESERVE requests for the rest of the day, a watcher asks every five
# minutes (one request each, scripts/free-quota.mjs) and stops the eval's
# process group below it; the case in progress then has no result and runs
# again next time. The judge is the same model unless JUDGE_MODEL names one.
#
#   MODEL=… TIER=… LABEL=… EVAL_ROOT=… EVAL_DIR=… GOLDEN_DIR=… RESERVE=… \
#     bash scripts/eval-free-run.sh
set -uo pipefail
export JUDGE_MODEL="${JUDGE_MODEL:-$MODEL}"
setsid node "$EVAL_ROOT/packages/eval/dist/main.js" run --dataset golden --tier "$TIER" \
  --golden-dir "$GOLDEN_DIR" --label "$LABEL" --out "$EVAL_DIR" --retry-failed \
  --config "$RUNNER_TEMP/ocra-free.json" &
pid=$!
stopped=""
while kill -0 "$pid" 2>/dev/null; do
  for _ in $(seq 60); do kill -0 "$pid" 2>/dev/null || break; sleep 5; done
  kill -0 "$pid" 2>/dev/null || break
  left=$(node scripts/free-quota.mjs "$MODEL")
  if [[ "$left" =~ ^[0-9]+$ ]] && [ "$left" -lt "$RESERVE" ]; then
    stopped=$left
    kill -TERM -- "-$pid" 2>/dev/null
    break
  fi
done
wait "$pid"
code=$?
if [ -n "$stopped" ]; then
  echo "::notice title=Free eval paused::stopped with $stopped free request(s) left; the cycle resumes on the next run"
  echo "Stopped with $stopped free request(s) left." >> "$GITHUB_STEP_SUMMARY"
  exit 0
fi
exit "$code"
