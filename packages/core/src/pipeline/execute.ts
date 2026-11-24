import {
  type AgentCallSettings,
  type AgentSettings,
  chainOf,
  reviewerCall,
} from "../agent/settings.js";
import { addUsage, emptyUsage } from "../agent/usage.js";
import { type AnchorContext, anchorFinding } from "../anchor/anchor.js";
import type { AgentRuntime, ReferenceIndex, SymbolExtractor, Usage } from "../contracts.js";
import type { GuidelineScope } from "../docs/guidelines.js";
import type { Finding, TaskFinding } from "../domain.js";
import type { MatrixCell } from "../matrix/matrix.js";
import type { ReviewEvent, TaskOutcome } from "../report/report.js";
import type { OptionalContext } from "../review/context-sources.js";
import { findCallers } from "../review/impact.js";
import { planBundle } from "../review/plan-phase.js";
import { buildReviewPrompt, type ReviewPrompt } from "../review/prompt.js";
import { toFinding } from "./findings.js";
import type { ReviewPlan } from "./plan.js";
import { stableHash } from "./provenance.js";
import type { ReusePool } from "./resume.js";
import { executeTask } from "./task.js";
import { type TaskPrompt, type TaskSettings, taskPrompt } from "./task-prompt.js";

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
  // Sources left out of every prompt (ADR-0057).
  without?: ReadonlySet<OptionalContext>;
  guidelineScope?: GuidelineScope;
  // The files a security reviewer reviews in the matrix (securityReviewed).
  securityFiles?: ReadonlySet<string>;
  taskTimeoutMs: number;
  abortGraceMs?: number | undefined;
  relocate?: AnchorContext["relocate"] | undefined;
  symbols?: SymbolExtractor | undefined;
  references?: ReferenceIndex | undefined;
  // One plan per reviewer and bundle, shared by --ultra's two samples.
  plans?: Map<string, Promise<PlannedBundle>>;
  emit: (event: ReviewEvent) => void;
  // Spend as it happens: plan calls when they return, review tasks as their
  // runtime reports it. JobResult.usage still carries the total.
  onUsage?: ((usage: Usage) => void) | undefined;
  signal: AbortSignal;
  agents?: AgentSettings;
  // Completed tasks of an earlier run (--resume) and that run's id.
  reuse?: { pool: ReusePool; runId: string };
  // What else a task's answer depends on: the ocra build and the sampling.
  keyInputs?: unknown;
}

type PlannedBundle = Awaited<ReturnType<typeof planBundle>>;

// A cell's prompt and the key of its inputs (taskKey), under which its
// answer is reported and an earlier run's answer is reused.
export interface PreparedJob {
  task: TaskPrompt;
  key: string;
}

export function prepareJob(
  job: MatrixCell,
  plan: ReviewPlan,
  options: ExecuteOptions,
): PreparedJob {
  const call = reviewerCall(job.reviewer, options.agents ?? {});
  const task = taskPrompt(job, plan, settingsOf(options));
  return { task, key: taskKey(job, plan, task.prompt, call, options) };
}

function settingsOf(options: ExecuteOptions): TaskSettings {
  return {
    ultra: options.ultra === true,
    securityFiles: options.securityFiles ?? new Set(),
    ...(options.without ? { without: options.without } : {}),
    ...(options.guidelineScope ? { guidelineScope: options.guidelineScope } : {}),
  };
}

// Runs one (bundle, reviewer) cell and anchors what it reports.
export async function runJob(
  job: MatrixCell,
  plan: ReviewPlan,
  options: ExecuteOptions,
  { task, key }: PreparedJob,
): Promise<JobResult> {
  const { emit } = options;
  const files = job.bundle.files.map((f) => f.newPath);
  const call = reviewerCall(job.reviewer, options.agents ?? {});
  const prepared = await preparePrompt(job, plan, options, call, task);
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
      sharedPrefixes: prepared.prompt.shared,
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
      citable: task.citable,
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
  if (result.quota !== undefined) outcome.quota = result.quota;
  if (result.ended !== undefined) outcome.ended = result.ended;
  if (result.wrapUp) outcome.wrapUp = result.wrapUp;
  // A task cut off before it finished (ADR-0030) is reviewed again, not reused.
  if (result.status === "completed" && result.ended === undefined) {
    emit({ type: "task_reported", taskId: job.taskId, key, findings: result.findings });
  }
  emit({ type: "task_finished", outcome });
  return { outcome, findings: anchored.findings, usage, warnings };
}

// Everything a task's answer depends on, so an earlier answer is reused only
// for the same question: the prompt (instructions, change, bundle, rules,
// guidelines, memory), the commits (the code around the change, which the
// reviewer reads but the prompt does not hold), the model chain and effort,
// --ultra (which adds a plan phase and callers; callers at the full tier,
// like the plan, are derived from the same inputs), and the caller's build
// and sampling.
function taskKey(
  job: MatrixCell,
  plan: ReviewPlan,
  prompt: ReviewPrompt,
  call: AgentCallSettings,
  options: ExecuteOptions,
): string {
  const { baseSha, headSha } = plan.changeRequest;
  return stableHash({
    prompt: { system: prompt.system, user: prompt.user },
    commits: { base: baseSha, head: headSha },
    tier: job.reviewer.modelTier,
    chain: chainOf(call, job.reviewer.modelTier, options.agents ?? {}),
    effort: call.effort,
    ultra: options.ultra === true,
    inputs: options.keyInputs,
  });
}

// A cell an earlier run already answered, when the reuse pool holds an answer
// under its key: the reported findings are anchored again (the change is the
// same, so they land where they did) and it costs nothing, so the stage takes
// it before the spend limit; its outcome says where it came from. Undefined
// when the cell has to run.
export async function reuseJob(
  job: MatrixCell,
  plan: ReviewPlan,
  options: ExecuteOptions,
  key: string,
): Promise<JobResult | undefined> {
  const earlier = options.reuse?.pool.take(key);
  if (!earlier || !options.reuse) return undefined;
  const { runId } = options.reuse;
  const { emit } = options;
  const files = job.bundle.files.map((f) => f.newPath);
  emit({
    type: "task_started",
    taskId: job.taskId,
    reviewer: job.reviewer.id,
    bundle: job.bundle.label,
    files,
  });
  const anchored = await anchorFindings(job, plan, options, earlier.findings);
  emit({ type: "task_reported", taskId: job.taskId, key, findings: [...earlier.findings] });
  const { error: _error, ...prior } = earlier.outcome;
  const outcome: TaskOutcome = {
    ...prior,
    taskId: job.taskId,
    reviewer: job.reviewer.id,
    bundle: job.bundle.label,
    files,
    status: "completed",
    findings: anchored.findings.length,
    reusedFrom: earlier.outcome.reusedFrom ?? runId,
  };
  emit({ type: "task_finished", outcome });
  return { outcome, findings: anchored.findings, usage: emptyUsage(), warnings: anchored.warnings };
}

interface PreparedPrompt {
  prompt: ReviewPrompt;
  // The plan phase's, for the sample that made the call.
  usage: Usage[];
  warnings: string[];
}

// The review prompt, with a plan phase and the callers of changed symbols
// when the task gets them.
async function preparePrompt(
  job: MatrixCell,
  plan: ReviewPlan,
  options: ExecuteOptions,
  call: AgentCallSettings,
  task: TaskPrompt,
): Promise<PreparedPrompt> {
  const { planCall } = task;
  const callers = task.callers ? await findCallers(job.bundle.files, plan.context, options) : [];
  if (!planCall) {
    const prompt = callers.length > 0 ? buildReviewPrompt({ ...task.input, callers }) : task.prompt;
    return { prompt, usage: [], warnings: [] };
  }
  const shared = options.plans?.get(planCall.key);
  const planning =
    shared ?? planBundle(options.runtime, job.reviewer, planCall.prompt(), options.signal, call);
  if (!shared) options.plans?.set(planCall.key, planning);
  const planned = await planning;
  const prompt = buildReviewPrompt({
    ...task.input,
    callers,
    plan: planned.plan,
    planPhase: "after",
  });
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
  // A finding on another file of the change is kept: a bug often shows where
  // a changed caller meets a changed callee in another bundle, and dropping
  // it lost the finding outright. A copy the task owning that file also
  // reports shares its fingerprint, so the run keeps one (dedupeFindings).
  // A file outside the change, or left out of an incremental review, is
  // not under review.
  const reviewed = new Set(plan.bundles.flatMap((b) => b.files.map((f) => f.newPath)));
  let outside = 0;
  for (const { reported, model } of reportedFindings) {
    // Relocating a quote on a file outside the review would pay for an
    // answer the next check throws away.
    const context = reviewed.has(reported.file)
      ? anchorContext
      : { diffs: anchorContext.diffs, readNewFile: anchorContext.readNewFile };
    const anchor = await anchorFinding(reported, context);
    if (anchor.warning) warnings.push(`${job.taskId}: ${anchor.warning}`);
    if (!reviewed.has(anchor.file)) {
      outside += 1;
      options.emit({
        type: "finding_dropped",
        taskId: job.taskId,
        reason: "outside_review",
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
    warnings.push(`${job.taskId}: dropped ${outside} finding(s) on files outside the review`);
  }
  return { findings, warnings };
}
