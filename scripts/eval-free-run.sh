#!/usr/bin/env bash
# The free golden eval of eval-free.yml: ocra-eval reviews the cycle's cases
# and stops by itself when the quota refuses one. To leave HEADROOM requests
# for the rest of the day, a watcher asks every five minutes (one request
# each, scripts/free-quota.mjs) and stops the eval's process group below it;
# the case in progress then has no result and runs again next time.
#
#   MODEL=… LABEL=… EVAL_DIR=… HEADROOM=… bash scripts/eval-free-run.sh
set -uo pipefail
export JUDGE_MODEL="$MODEL"
setsid node packages/eval/dist/main.js run --dataset golden --tier smoke \
  --label "$LABEL" --out "$EVAL_DIR" --retry-failed \
  --config "$RUNNER_TEMP/ocra-free.json" &
pid=$!
stopped=""
while kill -0 "$pid" 2>/dev/null; do
  for _ in $(seq 60); do kill -0 "$pid" 2>/dev/null || break; sleep 5; done
  kill -0 "$pid" 2>/dev/null || break
  left=$(node scripts/free-quota.mjs "$MODEL")
  if [[ "$left" =~ ^[0-9]+$ ]] && [ "$left" -lt "$HEADROOM" ]; then
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
