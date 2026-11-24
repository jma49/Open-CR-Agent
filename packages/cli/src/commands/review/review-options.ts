import type { GuidelineScope, ReviewLimits, ReviewOptions } from "@open-cr-agent/core";
import { agentChains, smallestContextWindow } from "../../config/cli-config.js";
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
  const contextWindow = smallestContextWindow(config.providers, [
    ...Object.values(config.models),
    ...Object.values(agentChains({ reviewers: run.overrides, roles: config.roles })),
  ]);
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
    ...(contextWindow !== undefined ? { contextWindow } : {}),
  };
  return {
    reviewers: run.registry.reviewers,
    reviewerOverrides: run.overrides,
    effort: config.effort,
    roles: config.roles,
    models: config.models,
    rules: run.rules,
    selection: { include: config.include, exclude: config.exclude },
    readTrusted: (path) => run.target.trusted.readFile(path),
    learnings: run.learnings,
    ...(args.noLinkedTasks || config.linkedTasks === false ? { linkedTasks: false } : {}),
    ...scopeOf(args.guidelineScope ?? config.guidelineScope),
    ...(run.taskSources.length > 0 ? { taskSources: run.taskSources } : {}),
    ...(run.projectDocs.length > 0 ? { projectDocs: run.projectDocs } : {}),
    ...(config.mergeChecks?.length ? { mergeChecks: config.mergeChecks } : {}),
    ...(run.sarifEvidence.length > 0 ? { sarifEvidence: run.sarifEvidence } : {}),
    limits,
    ...inlineOf(config),
    stages: {
      ...(config.verify !== undefined ? { verify: config.verify } : {}),
      ...(config.judge !== undefined ? { judge: config.judge } : {}),
      ...(config.showPreExisting !== undefined ? { showPreExisting: config.showPreExisting } : {}),
      walkthrough:
        config.walkthrough ?? (args.pullRequest !== undefined || args.mergeRequest !== undefined),
      ...(args.fixes || config.fixes ? { fixes: true } : {}),
    },
    mode: {
      ...(run.ultra ? { ultra: true } : {}),
      ...(args.full ? { full: true } : {}),
      ...(args.without ? { without: args.without } : {}),
    },
  };
}

function inlineOf(config: ResolvedRun["config"]): Pick<ConfiguredOptions, "inline"> {
  const { minInlineSeverity: minSeverity, maxInlineComments: maxComments } = config;
  if (minSeverity === undefined && maxComments === undefined) return {};
  return {
    inline: {
      ...(minSeverity !== undefined ? { minSeverity } : {}),
      ...(maxComments !== undefined ? { maxComments } : {}),
    },
  };
}

function scopeOf(scope: GuidelineScope | undefined): { guidelineScope?: GuidelineScope } {
  return scope ? { guidelineScope: scope } : {};
}
