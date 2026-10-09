import { SpendLimitReached, type SpendTracker } from "../agent/budget.js";
import { mapWithConcurrency } from "../agent/pool.js";
import { roleCall } from "../agent/settings.js";
import { emptyUsage } from "../agent/usage.js";
import type { AnchorContext, RelocationRequest } from "../anchor/anchor.js";
import { runtimeRelocator } from "../anchor/relocate.js";
import type { Usage } from "../contracts.js";
import {
  DEFAULT_MAX_TASKS,
  type MatrixCell,
  planTasks,
  type ReviewMatrix,
} from "../matrix/matrix.js";
import type { ReviewEvent, TaskOutcome } from "../report/report.js";
import type { ReviewerDefinition } from "../review/reviewer.js";
import { type ExecuteOptions, type JobResult, jobKey, reuseJob, runJob } from "./execute.js";
import { MAX_TIMER_MS, REVIEW_DEFAULTS, type ReviewHooks, type ReviewOptions } from "./options.js";
import type { ReviewPlan } from "./plan.js";
import { reusePool } from "./resume.js";

export interface StageContext {
  options: ReviewOptions & ReviewHooks;
  plan: ReviewPlan;
  budget: SpendTracker;
  signal: AbortSignal;
  emit: (event: ReviewEvent) => void;
}

export interface ExecuteStage {
  matrix: ReviewMatrix;
  results: JobResult[];
  // Tasks that never started leave their files unreviewed, not failed.
  notStarted: ReadonlySet<string>;
  // The light-model relocation calls, appended as they are made.
  relocations: readonly Usage[];
  usage(): Usage[];
  warnings: string[];
  // The review share of the spend limit stopped tasks or kept some from starting.
  reviewLimitReached(): boolean;
}

// One agent task per (bundle, reviewer) cell of the matrix, within the task
// limit, the run's signal and the review share of the spend limit.
export async function executeStage(
  reviewers: readonly ReviewerDefinition[],
  context: StageContext,
): Promise<ExecuteStage> {
  const { options, plan, emit } = context;
  const matrix = planTasks(plan.bundles, reviewers, plan.tier, options.reviewerOverrides, {
    ultra: options.mode?.ultra === true,
    ...(options.limits?.maxTasks !== undefined ? { maxTasks: options.limits?.maxTasks } : {}),
    hasGuidelines: Boolean(plan.guidelines?.trim()),
  });
  const warnings: string[] = [];
  const limited = matrix.skipped.filter((s) => s.reason === "task_limit").length;
  if (limited > 0) {
    warnings.push(
      `task limit of ${options.limits?.maxTasks ?? DEFAULT_MAX_TASKS} reached: ${limited} review task(s) skipped; their files are reported as not reviewed`,
    );
  }
  emit({ type: "matrix_planned", tasks: matrix.cells.length, skipped: matrix.skipped });
  const relocations: Usage[] = [];
  const spendLimit = new AbortController();
  const execute = executeOptions(context, relocations, spendLimit);
  const resume = options.resume;
  const pool = reusePool(resume);
  if (resume) execute.reuse = { pool, runId: resume.runId };
  const notStarted = new Set<string>();
  let unaffordable = 0;
  const results = await mapWithConcurrency(
    matrix.cells,
    options.limits?.concurrency ?? REVIEW_DEFAULTS.concurrency,
    async (cell) => {
      // Once the run is cancelled or timed out, remaining cells are not started.
      if (context.signal.aborted) {
        notStarted.add(cell.taskId);
        return skipCell(cell, "run cancelled before this task started", emit);
      }
      const key = jobKey(cell, plan, execute);
      const reused = await reuseJob(cell, plan, execute, key);
      if (reused) return reused;
      if (context.budget.reviewExhausted()) {
        notStarted.add(cell.taskId);
        unaffordable += 1;
        return skipCell(cell, `spend limit of $${options.limits?.maxCostUsd} reached`, emit);
      }
      return runJob(cell, plan, execute, key);
    },
  );
  if (unaffordable > 0) {
    warnings.push(
      `spend limit of $${options.limits?.maxCostUsd} reached: ${unaffordable} review task(s) did not start; their files are reported as not reviewed`,
    );
  }
  if (resume) warnings.push(...resumeWarnings(resume.runId, pool.unused()));
  warnings.push(...results.flatMap((r) => r.warnings));
  return {
    matrix,
    results,
    notStarted,
    relocations,
    usage: () => [...results.map((r) => r.usage), ...relocations],
    warnings,
    reviewLimitReached: () => spendLimit.signal.aborted || unaffordable > 0,
  };
}

function executeOptions(
  { options, budget, signal, emit }: StageContext,
  relocations: Usage[],
  spendLimit: AbortController,
): ExecuteOptions {
  const relocator = relocatorOf(options, signal, (u) => {
    relocations.push(u);
    budget.add(u);
  });
  return {
    runtime: options.runtime,
    taskTimeoutMs: Math.min(
      options.limits?.taskTimeoutMs ?? REVIEW_DEFAULTS.taskTimeoutMs,
      MAX_TIMER_MS,
    ),
    abortGraceMs: options.abortGraceMs,
    // Past the spend limit a quote that does not match stays file-level.
    relocate:
      relocator &&
      (async (request: RelocationRequest) => (budget.exhausted() ? undefined : relocator(request))),
    ultra: options.mode?.ultra === true,
    plans: new Map(),
    agents: options,
    keyInputs: keyInputs(options),
    emit,
    // Tasks report spend while they run, so the one that uses up the review
    // share stops every task still running, not only the ones not yet started.
    onUsage: (usage: Usage) => {
      budget.add(usage);
      if (budget.reviewExhausted() && !spendLimit.signal.aborted) {
        spendLimit.abort(new SpendLimitReached(options.limits?.maxCostUsd ?? 0));
      }
    },
    signal: AbortSignal.any([signal, spendLimit.signal]),
  };
}

// The caller's build and sampling: an earlier run made with another ocra or
// other sampling settings answered a different question.
function keyInputs({ identity }: ReviewOptions): unknown {
  const provenance = identity?.provenance;
  return provenance && { ocraVersion: provenance.ocraVersion, sampling: provenance.sampling };
}

// Reused tasks are named in report.tasks (reusedFrom); only what could not be
// reused is worth a warning.
function resumeWarnings(runId: string, unused: number): string[] {
  if (unused === 0) return [];
  return [
    `resumed run ${runId}: ${unused} completed task(s) not reused, their inputs changed (commits, configuration, prompts or ocra version)`,
  ];
}

function relocatorOf(
  options: ReviewOptions & ReviewHooks,
  signal: AbortSignal,
  onUsage: (usage: Usage) => void,
): AnchorContext["relocate"] | undefined {
  if (options.relocate === false) return undefined;
  return (
    options.relocate ??
    runtimeRelocator(options.runtime, signal, onUsage, roleCall("helper", options))
  );
}

function skipCell(cell: MatrixCell, reason: string, emit: (event: ReviewEvent) => void): JobResult {
  const outcome: TaskOutcome = {
    taskId: cell.taskId,
    reviewer: cell.reviewer.id,
    bundle: cell.bundle.label,
    files: cell.bundle.files.map((f) => f.newPath),
    status: "cancelled",
    error: reason,
    findings: 0,
    durationMs: 0,
    usage: emptyUsage(),
  };
  emit({ type: "task_finished", outcome });
  return { outcome, findings: [], usage: emptyUsage(), warnings: [] };
}
