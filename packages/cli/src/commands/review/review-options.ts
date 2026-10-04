import type { ReviewLimits, ReviewOptions } from "@open-cr-agent/core";
import type { ReviewArgs } from "./args.js";
import type { ResolvedRun } from "./resolve-run.js";

export type ConfiguredOptions = Omit<
  ReviewOptions,
  "vcs" | "runtime" | "identity" | "sarif" | "accountMemory" | "signal" | "onEvent"
>;

// What the configuration and the flags decide about a review, mapped once
// for the review and its --plan preview: minutes become milliseconds, and
// --max-cost-usd overrides the configured limit.
export function configuredOptions(run: ResolvedRun, args: ReviewArgs): ConfiguredOptions {
  const { config } = run;
  const maxCostUsd = args.maxCostUsd ?? config.maxCostUsd;
  const limits: ReviewLimits = {
    ...(config.concurrency !== undefined ? { concurrency: config.concurrency } : {}),
    ...(config.taskTimeoutMinutes !== undefined
      ? { taskTimeoutMs: config.taskTimeoutMinutes * 60_000 }
      : {}),
    ...(config.runTimeoutMinutes !== undefined
      ? { runTimeoutMs: config.runTimeoutMinutes * 60_000 }
      : {}),
    ...(maxCostUsd !== undefined ? { maxCostUsd } : {}),
    ...(config.maxTasks !== undefined ? { maxTasks: config.maxTasks } : {}),
  };
  return {
    reviewers: run.registry.reviewers,
    reviewerOverrides: run.overrides,
    effort: config.effort,
    roles: config.roles,
    models: config.models,
    rules: run.rules,
    selection: { include: config.include, exclude: config.exclude },
    ...(run.target.readTrusted ? { readTrusted: run.target.readTrusted } : {}),
    limits,
    stages: {
      ...(config.verify !== undefined ? { verify: config.verify } : {}),
      ...(config.judge !== undefined ? { judge: config.judge } : {}),
    },
    mode: { ...(run.ultra ? { ultra: true } : {}), ...(args.full ? { full: true } : {}) },
  };
}
