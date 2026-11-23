import { z } from "zod";
import type { PerfResult } from "./measure.js";

// Ceilings for one measured review; a measure left out has none.
export const perfBudgetSchema = z.strictObject({
  wallMs: z.number().positive().exactOptional(),
  firstVerifiedMs: z.number().positive().exactOptional(),
  cpuMs: z.number().positive().exactOptional(),
  peakMemoryMb: z.number().positive().exactOptional(),
  gitProcesses: z.number().positive().exactOptional(),
  modelRequests: z.number().positive().exactOptional(),
  inputTokens: z.number().positive().exactOptional(),
});
export type PerfBudget = z.output<typeof perfBudgetSchema>;

const MEASURES: Record<keyof PerfBudget, { label: string; of: (r: PerfResult) => number }> = {
  wallMs: { label: "wall time (ms)", of: (r) => r.wallMs },
  firstVerifiedMs: { label: "first verified finding (ms)", of: (r) => r.firstVerifiedMs ?? 0 },
  cpuMs: { label: "ocra CPU time (ms)", of: (r) => r.cpuMs },
  peakMemoryMb: { label: "peak memory (MB)", of: (r) => r.peakMemoryMb },
  gitProcesses: { label: "git processes", of: (r) => r.git.processes },
  modelRequests: { label: "model requests", of: (r) => r.model.requests },
  inputTokens: { label: "input tokens", of: (r) => r.model.inputTokens },
};

// One line per measure over its ceiling; empty when the review is within all.
export function overBudget(result: PerfResult, budget: PerfBudget): string[] {
  return (Object.keys(MEASURES) as (keyof PerfBudget)[]).flatMap((name) => {
    const ceiling = budget[name];
    const { label, of } = MEASURES[name];
    return ceiling !== undefined && of(result) > ceiling
      ? [`${label}: ${of(result)}, over its budget of ${ceiling}`]
      : [];
  });
}

export function renderPerf(result: PerfResult): string {
  const { review, git, model } = result;
  const share = (part: number, whole: number) =>
    whole === 0 ? "0%" : `${Math.round((100 * part) / whole)}%`;
  const commands = Object.entries(git.byCommand)
    .sort((a, b) => b[1] - a[1])
    .map(([command, n]) => `${command} ${n}`)
    .join(", ");
  const kinds = Object.entries(model.byKind)
    .filter(([, calls]) => calls.requests > 0)
    .map(
      ([kind, calls]) =>
        `| ${kind} | ${calls.requests} | ${calls.inputTokens} | ${calls.largestRequestTokens} | ${share(calls.repeatedTokens, calls.inputTokens)} |`,
    );
  return [
    `Review: ${review.files} file(s), ${review.tasks} task(s), ${review.findings} finding(s), exit ${review.exitCode}; ${result.runtime} runtime, ${result.latencyMs} ms per model request`,
    "",
    "| Measure | Value |",
    "|---|---|",
    `| Wall time | ${(result.wallMs / 1000).toFixed(1)} s |`,
    ...(result.firstVerifiedMs === undefined
      ? []
      : [`| First verified finding | ${(result.firstVerifiedMs / 1000).toFixed(1)} s |`]),
    `| ocra CPU time | ${(result.cpuMs / 1000).toFixed(1)} s |`,
    `| Peak memory | ${result.peakMemoryMb} MB |`,
    `| git processes | ${git.processes} (${commands}) |`,
    `| Model requests | ${model.requests} |`,
    `| Input tokens | ${model.inputTokens} (${share(model.repeatedTokens, model.inputTokens)} repeat the start of an earlier request) |`,
    "",
    "| Model call | Requests | Input tokens | Largest request | Repeated |",
    "|---|---|---|---|---|",
    ...kinds,
    "",
  ].join("\n");
}
