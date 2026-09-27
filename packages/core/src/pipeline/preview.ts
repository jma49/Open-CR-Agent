import { defaultBundlePolicy } from "../bundle/bundle.js";
import type { ChangeRequest, RiskTier } from "../domain.js";
import { memoryFor } from "../memory/memory.js";
import { buildReviewPrompt } from "../review/prompt.js";
import type { ReviewerDefinition } from "../review/reviewer.js";
import { correctnessReviewer } from "../review/reviewers/correctness.js";
import { resolveRules } from "../rules/resolve.js";
import type { FileDecision } from "../select/select.js";
import { planTasks, type ReviewerOverrides, type SkippedCell } from "./matrix.js";
import { type PlanOptions, planReview } from "./plan.js";

export interface PreviewTask {
  taskId: string;
  reviewer: string;
  bundle: string;
  files: string[];
  // The first request's prompt, estimated at four characters per token.
  promptTokens: number;
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
  warnings: string[];
}

export type PreviewOptions = Omit<PlanOptions, "runtime"> & {
  reviewers?: readonly ReviewerDefinition[];
  reviewerOverrides?: ReviewerOverrides;
  ultra?: boolean;
  maxTasks?: number;
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

  const tasks = cells.map((cell): PreviewTask => {
    const files = cell.bundle.files.map((f) => f.newPath);
    const prompt = buildReviewPrompt({
      reviewer: cell.reviewer,
      changeRequest: plan.changeRequest,
      changedFiles: plan.selected,
      bundle: cell.bundle.files,
      rules: resolveRules(files, plan.repoRules, cell.reviewer.rules),
      guidelines: plan.guidelines,
      accepted: memoryFor(files, plan.memory),
    });
    return {
      taskId: cell.taskId,
      reviewer: cell.reviewer.id,
      bundle: cell.bundle.label,
      files,
      promptTokens: Math.ceil((prompt.system.length + prompt.user.length) / 4),
    };
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
    promptTokens: tasks.reduce((sum, t) => sum + t.promptTokens, 0),
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
