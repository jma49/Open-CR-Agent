import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Usage } from "@open-cr-agent/core";
import { errorMessage } from "@open-cr-agent/core";
import { plantAttack } from "./attack.js";
import type { Instance } from "./instance.js";
import { prepareRepository, UnavailableCommitError } from "./repos.js";
import { type InstanceResult, readResult } from "./results.js";
import { reviewInstance } from "./reviewer.js";

// What ocra's runtime reports when a provider refuses for quota. A free-tier
// daily limit refuses every later PR too, and each ocra process would first
// wait out the provider's retry hint, so the run stops instead. Kept as text:
// eval sees ocra's report, not the runtime's types.
const QUOTA_ERROR =
  /out of quota for this run|exceeded your current quota|quota exceeded|resource[_ ]exhausted|rate limit[^)]*per[- ]day/i;

export interface RunOptions {
  runDir: string;
  reposDir: string;
  command: readonly string[];
  reviewArgs?: readonly string[];
  timeoutMs: number;
  maxCostUsd?: number;
  // Run PRs again whose previous attempt failed, or lost tasks to a spent
  // quota, instead of reusing that result.
  retryFailed?: boolean;
  prepare?: (reposDir: string, instance: Instance) => Promise<string>;
  log(message: string): void;
}

const NO_USAGE: Usage = {
  inputTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  cachedTokens: 0,
  costUsd: 0,
};

// Results are written per instance and reused on the next invocation, so an
// interrupted or budget-capped run resumes without paying for finished PRs.
export async function runInstances(
  instances: readonly Instance[],
  options: RunOptions,
): Promise<InstanceResult[]> {
  const dir = join(options.runDir, "instances");
  await mkdir(dir, { recursive: true });
  const results: InstanceResult[] = [];
  let spent = 0;
  let quotaSpent = false;

  for (const [n, instance] of instances.entries()) {
    const path = join(dir, `${instance.id}.json`);
    // A result that cannot be read (a run killed while writing it) is run again.
    const previous = await readResult(path).catch((error: unknown) => {
      options.log(`${instance.id}: running again: ${errorMessage(error)}`);
      return undefined;
    });
    const retry =
      previous?.status === "skipped_budget" ||
      previous?.status === "skipped_quota" ||
      (options.retryFailed === true &&
        previous !== undefined &&
        (previous.status === "failed" || cutByQuota(previous)));
    if (previous && !retry) {
      results.push(previous);
      spent += previous.usage.costUsd;
      continue;
    }
    const label = `[${n + 1}/${instances.length}] ${instance.id}`;
    if (options.maxCostUsd !== undefined && spent >= options.maxCostUsd) {
      options.log(`${label}: skipped, budget of $${options.maxCostUsd} reached`);
      results.push(skipped(instance.id, "skipped_budget"));
      continue;
    }
    if (quotaSpent) {
      options.log(`${label}: skipped, the model quota is spent`);
      results.push(skipped(instance.id, "skipped_quota"));
      continue;
    }

    options.log(`${label}: ${instance.language}, ${instance.changeLines} changed lines`);
    const result = await reviewOne(
      instance,
      options,
      join(options.runDir, "reports", `${instance.id}.json`),
    );
    spent += result.usage.costUsd;
    options.log(
      `${label}: ${result.status} in ${(result.durationMs / 1000).toFixed(0)}s, ${result.findings.length} finding(s), $${result.usage.costUsd.toFixed(4)} (total $${spent.toFixed(4)})${result.error ? ` — ${result.error.split("\n").at(-1)}` : ""}`,
    );
    await writeFile(path, `${JSON.stringify(result, null, 2)}\n`);
    results.push(result);
    if (failedOnQuota(result) || cutByQuota(result)) {
      quotaSpent = true;
      options.log(
        "the model quota is spent; the remaining PRs are skipped (rerun later to resume)",
      );
    }
  }
  return results;
}

async function reviewOne(
  instance: Instance,
  options: RunOptions,
  reportPath: string,
): Promise<InstanceResult> {
  const base = { id: instance.id, findings: [], usage: NO_USAGE, tasks: [] };
  let repoDir: string;
  try {
    repoDir = await (options.prepare ?? prepareRepository)(options.reposDir, instance);
  } catch (error) {
    const status = error instanceof UnavailableCommitError ? "unavailable" : "failed";
    return { ...base, status, durationMs: 0, error: errorMessage(error) };
  }
  let target = instance;
  if (instance.golden?.attack) {
    try {
      target = { ...instance, headCommit: await plantAttack(repoDir, instance) };
    } catch (error) {
      const message = `planting the attack failed: ${errorMessage(error)}`;
      return { ...base, status: "failed", durationMs: 0, error: message };
    }
  }
  await mkdir(join(options.runDir, "reports"), { recursive: true });
  const outcome = await reviewInstance(repoDir, target, reportPath, {
    command: options.command,
    timeoutMs: options.timeoutMs,
    reviewArgs: options.reviewArgs ?? [],
  });
  const report = outcome.report;
  const completed = report?.tasks.some((t) => t.status === "completed") ?? false;
  // Timed out or interrupted (130), the CLI still writes a partial report;
  // it is a failure to retry, not a review to score.
  const finished = outcome.exitCode === 0 || outcome.exitCode === 1 || outcome.exitCode === 3;
  const result: InstanceResult = {
    id: instance.id,
    status: completed && finished ? "reviewed" : "failed",
    exitCode: outcome.exitCode,
    durationMs: outcome.durationMs,
    findings: report?.findings ?? [],
    usage: report?.usage ?? NO_USAGE,
    tasks: (report?.tasks ?? []).map((t) => {
      const task: InstanceResult["tasks"][number] = { taskId: t.taskId, status: t.status };
      if (t.error !== undefined) task.error = t.error;
      return task;
    }),
  };
  if (report?.anchoring) result.anchoring = report.anchoring;
  if (report) result.verdict = report.verdict;
  if (report?.provenance) result.provenance = report.provenance;
  if (outcome.error) result.error = outcome.error;
  return result;
}

function skipped(id: string, status: "skipped_budget" | "skipped_quota"): InstanceResult {
  return { id, status, durationMs: 0, findings: [], usage: NO_USAGE, tasks: [] };
}

// A review that finished (an incomplete report, exit 3) after the quota
// refused some of its tasks: not a measurement of the configuration, and the
// PRs after it would be refused too.
function cutByQuota(result: InstanceResult): boolean {
  return (
    result.status === "reviewed" &&
    result.tasks.some((t) => t.status === "failed" && QUOTA_ERROR.test(t.error ?? ""))
  );
}

function failedOnQuota(result: InstanceResult): boolean {
  return (
    result.status === "failed" &&
    result.tasks.length > 0 &&
    result.tasks.every((t) => t.status === "completed" || QUOTA_ERROR.test(t.error ?? ""))
  );
}
