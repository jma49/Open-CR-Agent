import { defaultBundlePolicy } from "../bundle/bundle.js";
import type { Effort } from "../contracts.js";
import type { ChangeRequest, RiskTier } from "../domain.js";
import { memoryFor } from "../memory/memory.js";
import type { ModelChains } from "../plugin/types.js";
import { buildReviewPrompt } from "../review/prompt.js";
import type { ReviewerDefinition } from "../review/reviewer.js";
import { correctnessReviewer } from "../review/reviewers/correctness.js";
import { resolveRules } from "../rules/resolve.js";
import type { FileDecision } from "../select/select.js";
import { reviewerCall } from "./agents.js";
import { isLargeBundle } from "./execute.js";
import { planTasks, type ReviewerOverrides, type SkippedCell } from "./matrix.js";
import { type PlanOptions, planReview } from "./plan.js";

export interface PreviewTask {
  taskId: string;
  reviewer: string;
  bundle: string;
  files: string[];
  // The first request's prompt, estimated at four characters per token.
  promptTokens: number;
  // The plan phase's one call before the review (--ultra, or a large bundle),
  // on the reviewer's tier; shared by --ultra's two samples.
  planPromptTokens?: number;
  // The reasoning effort the task and its plan call ask for; absent: the
  // provider's default.
  effort?: Effort;
  // The failback chain the task and its plan call use: the reviewer's own,
  // else its tier's; absent when neither is configured.
  models?: string[];
}

export interface ReviewPreview {
  changeRequest: ChangeRequest;
  tier: RiskTier;
  selected: string[];
  excluded: { path: string; reason: Exclude<FileDecision, { selected: true }>["reason"] }[];
  bundles: { label: string; files: string[] }[];
  // True when a real run would let the light model group the files instead.
  groupingSkipped: boolean;
  tasks: PreviewTask[];
  skipped: SkippedCell[];
  promptTokens: number;
  // Plan-phase calls the run would make; their prompts are in promptTokens.
  planCalls: number;
  warnings: string[];
}

export type PreviewOptions = Omit<PlanOptions, "runtime"> & {
  reviewers?: readonly ReviewerDefinition[];
  reviewerOverrides?: ReviewerOverrides;
  ultra?: boolean;
  maxTasks?: number;
  // The tier chains, to show each task's resolved chain.
  models?: ModelChains;
};

// Everything a review would do before its first model call, for free: which
// files, which tasks, and how large each first prompt is.
export async function previewReview(options: PreviewOptions): Promise<ReviewPreview> {
  const plan = await planReview(options, () => {}, new AbortController().signal);
  const reviewers = options.reviewers ?? [correctnessReviewer];
  const planned = planTasks(plan.bundles, reviewers, plan.tier, options.reviewerOverrides, {
    ultra: options.ultra === true,
    ...(options.maxTasks !== undefined ? { maxTasks: options.maxTasks } : {}),
    hasGuidelines: Boolean(plan.guidelines?.trim()),
  });
  const { cells } = planned;

  const plannedBundles = new Set<string>();
  const tasks = cells.map((cell): PreviewTask => {
    const files = cell.bundle.files.map((f) => f.newPath);
    const input = {
      reviewer: cell.reviewer,
      changeRequest: plan.changeRequest,
      changedFiles: plan.selected,
      bundle: cell.bundle.files,
      rules: resolveRules(files, plan.repoRules, cell.reviewer.rules),
      guidelines: plan.guidelines,
      accepted: memoryFor(files, plan.memory),
    };
    const prompt = buildReviewPrompt(input);
    const task: PreviewTask = {
      taskId: cell.taskId,
      reviewer: cell.reviewer.id,
      bundle: cell.bundle.label,
      files,
      promptTokens: tokens(prompt),
    };
    const call = reviewerCall(cell.reviewer, options);
    if (call.effort !== undefined) task.effort = call.effort;
    const models = call.models ?? options.models?.[cell.reviewer.modelTier];
    if (models?.length) task.models = [...models];
    const key = `${cell.reviewer.id}\0${cell.bundle.label}`;
    if ((options.ultra || isLargeBundle(cell.bundle.files)) && !plannedBundles.has(key)) {
      plannedBundles.add(key);
      task.planPromptTokens = tokens(buildReviewPrompt({ ...input, forPlanning: true }));
    }
    return task;
  });

  const policy = options.bundling ?? defaultBundlePolicy;
  return {
    changeRequest: plan.changeRequest,
    tier: plan.tier,
    selected: plan.selected.map((d) => d.newPath),
    excluded: plan.decisions.flatMap((d) =>
      d.selected ? [] : [{ path: d.diff.newPath, reason: d.reason }],
    ),
    bundles: plan.bundles.map((b) => ({ label: b.label, files: b.files.map((f) => f.newPath) })),
    groupingSkipped:
      options.grouper === undefined && plan.selected.length >= policy.groupingMinFiles,
    tasks,
    skipped: planned.skipped,
    promptTokens: tasks.reduce((sum, t) => sum + t.promptTokens + (t.planPromptTokens ?? 0), 0),
    planCalls: tasks.filter((t) => t.planPromptTokens !== undefined).length,
    warnings: [
      ...plan.warnings,
      ...(planned.limited?.length
        ? [
            `task limit reached: ${planned.limited.length} review task(s) would be skipped and their files reported as not reviewed`,
          ]
        : []),
    ],
  };
}

// Four characters per token: an estimate, not a tokenizer.
function tokens(prompt: { system: string; user: string }): number {
  return Math.ceil((prompt.system.length + prompt.user.length) / 4);
}
