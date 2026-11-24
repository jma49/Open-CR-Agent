import type { ReviewEvent, ReviewReport } from "@open-cr-agent/core";
import type { ReviewArgs } from "./args.js";
import { deliver, executeShown } from "./deliver.js";
import type { ReviewDeps } from "./deps.js";
import { executeRun } from "./execute-run.js";
import type { RunRequest } from "./request.js";
import { type ReviewIo, resolveRun } from "./resolve-run.js";

// One review, as `ocra review --format json` would run it, with its events
// and cancellation wired to the run.
export async function reviewOnce(
  request: RunRequest,
  signal: AbortSignal,
  onEvent: (event: ReviewEvent) => void,
  io: ReviewIo,
  deps: ReviewDeps,
): Promise<ReviewReport> {
  const args: ReviewArgs = {
    target: request.target,
    format: "json",
    ...(request.reviewers ? { reviewers: request.reviewers } : {}),
    ...(request.maxCostUsd !== undefined ? { maxCostUsd: request.maxCostUsd } : {}),
  };
  const runDeps: ReviewDeps = {
    ...deps,
    onEvent,
    onInterrupt(handler) {
      signal.addEventListener("abort", handler, { once: true });
      return () => signal.removeEventListener("abort", handler);
    },
  };
  const run = await resolveRun(args, io, runDeps);
  const executed = await executeShown(run, () => executeRun(run, args, io, runDeps));
  if (!executed.interrupted) await deliver(run, executed, args, io, runDeps);
  return executed.report;
}
