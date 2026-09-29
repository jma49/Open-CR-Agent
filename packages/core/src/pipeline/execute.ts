import { type AnchorContext, anchorFinding } from "../anchor/anchor.js";
import type { AgentRuntime, Usage } from "../contracts.js";
import type { Finding } from "../domain.js";
import { memoryFor } from "../memory/memory.js";
import { findCallers } from "../review/impact.js";
import { planBundle } from "../review/plan-phase.js";
import { buildReviewPrompt } from "../review/prompt.js";
import { resolveRules } from "../rules/resolve.js";
import { toFinding } from "./findings.js";
import type { MatrixCell } from "./matrix.js";
import type { ReviewPlan } from "./plan.js";
import type { ReviewEvent, TaskOutcome } from "./report.js";
import { executeTask } from "./task.js";
import { addUsage } from "./usage.js";

export interface JobResult {
  outcome: TaskOutcome;
  findings: Finding[];
  usage: Usage;
  warnings: string[];
}

export interface ExecuteOptions {
  runtime: AgentRuntime;
  // --ultra: a plan phase and the callers of changed symbols for every task.
  ultra?: boolean;
  taskTimeoutMs: number;
  abortGraceMs?: number | undefined;
  relocate?: AnchorContext["relocate"] | undefined;
  emit: (event: ReviewEvent) => void;
  signal: AbortSignal;
}

// In default mode only bundles large enough that a reviewer's 30 steps may
// not cover them get a plan phase; --ultra plans every task.
export const PLAN_MIN_FILES = 5;
export const PLAN_MIN_PATCH_CHARS = 40_000;

export function isLargeBundle(files: readonly { patch: string }[]): boolean {
  const chars = files.reduce((sum, f) => sum + f.patch.length, 0);
  return files.length >= PLAN_MIN_FILES || chars >= PLAN_MIN_PATCH_CHARS;
}

// Runs one (bundle, reviewer) cell and anchors what it reports.
export async function runJob(
  job: MatrixCell,
  plan: ReviewPlan,
  options: ExecuteOptions,
): Promise<JobResult> {
  const { emit } = options;
  const files = job.bundle.files.map((f) => f.newPath);
  const input = {
    reviewer: job.reviewer,
    changeRequest: plan.changeRequest,
    changedFiles: plan.selected,
    bundle: job.bundle.files,
    rules: resolveRules(files, plan.repoRules, job.reviewer.rules),
    guidelines: plan.guidelines,
    accepted: memoryFor(files, plan.memory),
  };
  const extraUsage: Usage[] = [];
  const extraWarnings: string[] = [];
  let prompt = buildReviewPrompt(input);
  if (options.ultra || isLargeBundle(job.bundle.files)) {
    const callers = options.ultra ? await findCallers(job.bundle.files, plan.context) : [];
    const planned = await planBundle(options.runtime, job.reviewer, prompt, options.signal);
    extraUsage.push(...planned.usage);
    if (planned.warning) extraWarnings.push(planned.warning);
    prompt = buildReviewPrompt({ ...input, callers, plan: planned.plan });
  }

  emit({
    type: "task_started",
    taskId: job.taskId,
    reviewer: job.reviewer.id,
    bundle: job.bundle.label,
    files,
  });
  const started = Date.now();
  const result = await executeTask(
    options.runtime,
    {
      taskId: job.taskId,
      reviewer: job.reviewer.id,
      modelTier: job.reviewer.modelTier,
      systemPrompt: prompt.system,
      userPrompt: prompt.user,
      context: plan.context,
      timeoutMs: options.taskTimeoutMs,
    },
    options.signal,
    {
      onProgress: (message) => emit({ type: "task_progress", taskId: job.taskId, message }),
      category: job.reviewer.category,
      abortGraceMs: options.abortGraceMs,
    },
  );

  const warnings = [...extraWarnings, ...result.warnings];
  const findings: Finding[] = [];
  const anchorContext: AnchorContext = {
    diffs: plan.selected,
    readNewFile: plan.context.readFile,
  };
  if (options.relocate) anchorContext.relocate = options.relocate;
  // A finding on a file outside the bundle belongs to the task that reviews
  // that file; keeping it would report the same issue once per bundle that
  // happened to read the file.
  const bundleFiles = new Set(files);
  let outside = 0;
  for (const reported of result.findings) {
    // Relocating a quote on a file outside the bundle would pay for an
    // answer the next check throws away.
    const context = bundleFiles.has(reported.file)
      ? anchorContext
      : { diffs: anchorContext.diffs, readNewFile: anchorContext.readNewFile };
    const anchor = await anchorFinding(reported, context);
    if (anchor.warning) warnings.push(`${job.taskId}: ${anchor.warning}`);
    if (!bundleFiles.has(anchor.file)) {
      outside += 1;
      continue;
    }
    const content = anchor.lineRange
      ? await plan.context.readFile(anchor.file).catch(() => undefined)
      : undefined;
    const finding = toFinding(reported, job.reviewer.id, anchor, content);
    findings.push(finding);
    emit({ type: "finding", taskId: job.taskId, finding });
  }
  if (outside > 0) {
    warnings.push(`${job.taskId}: dropped ${outside} finding(s) on files outside its bundle`);
  }

  const outcome: TaskOutcome = {
    taskId: job.taskId,
    reviewer: job.reviewer.id,
    bundle: job.bundle.label,
    files,
    status: result.status,
    findings: findings.length,
    durationMs: Date.now() - started,
  };
  if (result.error !== undefined) outcome.error = result.error;
  emit({ type: "task_finished", outcome });
  return { outcome, findings, usage: extraUsage.reduce(addUsage, result.usage), warnings };
}
