import { chainOf, reviewerCall } from "../agent/settings.js";
import { defaultBundlePolicy } from "../bundle/bundle.js";
import type { Effort } from "../contracts.js";
import type { ChangeRequest, RiskTier } from "../domain.js";
import { planTasks, type SkippedCell } from "../matrix/matrix.js";
import { correctnessReviewer } from "../review/reviewers/correctness.js";
import type { FileDecision } from "../select/select.js";
import { type ReviewOptions, runSettings } from "./options.js";
import { type PlanOptions, planReview, type ReviewPlan } from "./plan.js";
import { taskPrompt } from "./task-prompt.js";

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
  // Its first prompts, plan call included, at the input price of the first
  // model of its chain; absent without a chain or without prices to go by.
  inputCost?: InputCost;
}

// An estimate of input cost only: output, later turns, verification and
// judging are unknown before the run.
type InputCost =
  | { model: string; status: "priced"; usd: number }
  // Priced at 0, like models through ocra Cloud: no cost can be counted.
  | { model: string; status: "unpriced" }
  // Priced only by the runtime's catalog, which a plan does not read.
  | { model: string; status: "unknown" };

export interface ReviewPreview {
  changeRequest: ChangeRequest;
  tier: RiskTier;
  // As the run decides it: with a prior review, only what changed since it
  // when the platform can tell, else every file and why.
  scope?: NonNullable<ReviewPlan["scope"]>;
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
  // The priced tasks' input cost summed, and how many tasks are priced,
  // unpriced or of unknown price (no chain counts as unknown); absent when
  // no task has an estimate.
  inputCost?: { usd: number; priced: number; unpriced: number; unknown: number };
  warnings: string[];
}

// A review's options without the runtime; the preview reads what decides
// the files and the tasks.
export type PreviewOptions = Omit<PlanOptions, "runtime"> &
  Omit<ReviewOptions, "vcs" | "runtime"> & {
    // A model's input price in US dollars per million tokens: 0 when it is
    // unpriced, undefined when only the runtime's catalog knows it.
    inputPrice?: (model: string) => number | undefined;
  };

// Everything a review would do before its first model call, for free: which
// files, which tasks, and how large each first prompt is.
export async function previewReview(options: PreviewOptions): Promise<ReviewPreview> {
  const settings = runSettings(options);
  const plan = await planReview(
    { ...options, full: settings.full },
    () => {},
    new AbortController().signal,
  );
  const reviewers = options.reviewers ?? [correctnessReviewer];
  const planned = planTasks(plan.bundles, reviewers, plan.tier, options.reviewerOverrides, {
    ultra: settings.ultra,
    ...(settings.maxTasks !== undefined ? { maxTasks: settings.maxTasks } : {}),
    hasGuidelines: Boolean(plan.guidelines?.trim()),
  });
  const { cells } = planned;

  const plannedBundles = new Set<string>();
  const tasks = cells.map((cell): PreviewTask => {
    const prepared = taskPrompt(cell, plan, settings.ultra);
    const task: PreviewTask = {
      taskId: cell.taskId,
      reviewer: cell.reviewer.id,
      bundle: cell.bundle.label,
      files: cell.bundle.files.map((f) => f.newPath),
      promptTokens: tokens(prepared.prompt),
    };
    const call = reviewerCall(cell.reviewer, options);
    if (call.effort !== undefined) task.effort = call.effort;
    const models = chainOf(call, cell.reviewer.modelTier, options);
    if (models?.length) task.models = [...models];
    const { planCall } = prepared;
    if (planCall && !plannedBundles.has(planCall.key)) {
      plannedBundles.add(planCall.key);
      task.planPromptTokens = tokens(planCall.prompt);
    }
    const first = task.models?.[0];
    if (first !== undefined && options.inputPrice) {
      task.inputCost = inputCost(
        first,
        options.inputPrice(first),
        task.promptTokens + (task.planPromptTokens ?? 0),
      );
    }
    return task;
  });

  const policy = options.bundling ?? defaultBundlePolicy;
  return {
    changeRequest: plan.changeRequest,
    tier: plan.tier,
    ...(plan.scope ? { scope: plan.scope } : {}),
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
    ...(tasks.some((t) => t.inputCost) ? { inputCost: totalInputCost(tasks) } : {}),
    warnings: [
      ...(plan.prior.warning ? [plan.prior.warning] : []),
      ...plan.warnings,
      ...(planned.limited?.length
        ? [
            `task limit reached: ${planned.limited.length} review task(s) would be skipped and their files reported as not reviewed`,
          ]
        : []),
    ],
  };
}

function inputCost(model: string, price: number | undefined, promptTokens: number): InputCost {
  if (price === undefined) return { model, status: "unknown" };
  if (price === 0) return { model, status: "unpriced" };
  return { model, status: "priced", usd: (promptTokens * price) / 1_000_000 };
}

function totalInputCost(tasks: readonly PreviewTask[]): NonNullable<ReviewPreview["inputCost"]> {
  const total = { usd: 0, priced: 0, unpriced: 0, unknown: 0 };
  for (const { inputCost } of tasks) {
    if (inputCost?.status === "priced") total.usd += inputCost.usd;
    total[inputCost?.status ?? "unknown"] += 1;
  }
  return total;
}

// Four characters per token: an estimate, not a tokenizer.
function tokens(prompt: { system: string; user: string }): number {
  return Math.ceil((prompt.system.length + prompt.user.length) / 4);
}
