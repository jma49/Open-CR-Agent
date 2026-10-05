import { type AgentCallSettings, type AgentSettings, reviewerCall } from "../agent/settings.js";
import { addUsage } from "../agent/usage.js";
import { type AnchorContext, anchorFinding } from "../anchor/anchor.js";
import type { AgentRuntime, Usage } from "../contracts.js";
import type { Finding } from "../domain.js";
import { memoryFor } from "../memory/memory.js";
import type { ReviewEvent, TaskOutcome } from "../report/report.js";
import { findCallers } from "../review/impact.js";
import { planBundle } from "../review/plan-phase.js";
import { buildReviewPrompt, type ReviewPrompt } from "../review/prompt.js";
import { resolveRules } from "../rules/resolve.js";
import { toFinding } from "./findings.js";
import type { MatrixCell } from "./matrix.js";
import type { ReviewPlan } from "./plan.js";
import { executeTask, type TaskFinding } from "./task.js";

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
  // One plan per reviewer and bundle, shared by --ultra's two samples.
  plans?: Map<string, Promise<PlannedBundle>>;
  emit: (event: ReviewEvent) => void;
  // Spend as it happens: plan calls when they return, review tasks as their
  // runtime reports it. JobResult.usage still carries the total.
  onUsage?: ((usage: Usage) => void) | undefined;
  signal: AbortSignal;
  agents?: AgentSettings;
}

type PlannedBundle = Awaited<ReturnType<typeof planBundle>>;

// In default mode only bundles large enough that a reviewer's 30 steps may
// not cover them get a plan phase; --ultra plans every task.
const PLAN_MIN_FILES = 5;
const PLAN_MIN_PATCH_CHARS = 40_000;

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
  const call = reviewerCall(job.reviewer, options.agents ?? {});
  const prepared = await preparePrompt(job, plan, options, call);
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
      ...call,
      systemPrompt: prepared.prompt.system,
      userPrompt: prepared.prompt.user,
      context: plan.context,
      timeoutMs: options.taskTimeoutMs,
    },
    options.signal,
    {
      onProgress: (message, attempt) =>
        emit({
          type: "task_progress",
          taskId: job.taskId,
          message,
          ...(attempt ? { attempt } : {}),
        }),
      onUsage: options.onUsage,
      category: job.reviewer.category,
      abortGraceMs: options.abortGraceMs,
    },
  );
  const anchored = await anchorFindings(job, plan, options, result.findings);
  const warnings = [...prepared.warnings, ...result.warnings, ...anchored.warnings];
  const usage = prepared.usage.reduce(addUsage, result.usage);
  const outcome: TaskOutcome = {
    taskId: job.taskId,
    reviewer: job.reviewer.id,
    bundle: job.bundle.label,
    files,
    status: result.status,
    findings: anchored.findings.length,
    durationMs: Date.now() - started,
    usage,
  };
  if (result.error !== undefined) outcome.error = result.error;
  if (result.ended !== undefined) outcome.ended = result.ended;
  emit({ type: "task_finished", outcome });
  return { outcome, findings: anchored.findings, usage, warnings };
}

interface PreparedPrompt {
  prompt: ReviewPrompt;
  // The plan phase's, for the sample that made the call.
  usage: Usage[];
  warnings: string[];
}

// The review prompt, with a plan phase and, under --ultra, the callers of
// changed symbols.
async function preparePrompt(
  job: MatrixCell,
  plan: ReviewPlan,
  options: ExecuteOptions,
  call: AgentCallSettings,
): Promise<PreparedPrompt> {
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
  if (!options.ultra && !isLargeBundle(job.bundle.files)) {
    return { prompt: buildReviewPrompt(input), usage: [], warnings: [] };
  }
  const callers = options.ultra ? await findCallers(job.bundle.files, plan.context) : [];
  const key = `${job.reviewer.id}\0${job.bundle.label}`;
  const shared = options.plans?.get(key);
  const planning =
    shared ??
    planBundle(
      options.runtime,
      job.reviewer,
      buildReviewPrompt({ ...input, forPlanning: true }),
      options.signal,
      call,
    );
  if (!shared) options.plans?.set(key, planning);
  const planned = await planning;
  const prompt = buildReviewPrompt({ ...input, callers, plan: planned.plan });
  // The sample that made the call pays for it and reports its warning.
  if (shared) return { prompt, usage: [], warnings: [] };
  for (const usage of planned.usage) options.onUsage?.(usage);
  return { prompt, usage: [...planned.usage], warnings: planned.warning ? [planned.warning] : [] };
}

async function anchorFindings(
  job: MatrixCell,
  plan: ReviewPlan,
  options: ExecuteOptions,
  reportedFindings: readonly TaskFinding[],
): Promise<{ findings: Finding[]; warnings: string[] }> {
  const warnings: string[] = [];
  const findings: Finding[] = [];
  const anchorContext: AnchorContext = {
    diffs: plan.selected,
    readNewFile: plan.context.readFile,
  };
  if (options.relocate) anchorContext.relocate = options.relocate;
  // A finding on a file outside the bundle belongs to the task that reviews
  // that file; keeping it would report the same issue once per bundle that
  // happened to read the file.
  const bundleFiles = new Set(job.bundle.files.map((f) => f.newPath));
  let outside = 0;
  for (const { reported, model } of reportedFindings) {
    // Relocating a quote on a file outside the bundle would pay for an
    // answer the next check throws away.
    const context = bundleFiles.has(reported.file)
      ? anchorContext
      : { diffs: anchorContext.diffs, readNewFile: anchorContext.readNewFile };
    const anchor = await anchorFinding(reported, context);
    if (anchor.warning) warnings.push(`${job.taskId}: ${anchor.warning}`);
    if (!bundleFiles.has(anchor.file)) {
      outside += 1;
      options.emit({
        type: "finding_dropped",
        taskId: job.taskId,
        reason: "outside_bundle",
        file: anchor.file,
        title: reported.title,
      });
      continue;
    }
    const content = anchor.lineRange
      ? await plan.context.readFile(anchor.file).catch(() => undefined)
      : undefined;
    const provenance = model === undefined ? { task: job.taskId } : { task: job.taskId, model };
    const finding = toFinding(reported, job.reviewer.id, provenance, anchor, content);
    findings.push(finding);
    options.emit({ type: "finding", taskId: job.taskId, finding });
  }
  if (outside > 0) {
    warnings.push(`${job.taskId}: dropped ${outside} finding(s) on files outside its bundle`);
  }
  return { findings, warnings };
}
