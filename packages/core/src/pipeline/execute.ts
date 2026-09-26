import { type AnchorContext, anchorFinding } from "../anchor/anchor.js";
import type { AgentRuntime, Usage } from "../contracts.js";
import type { Finding } from "../domain.js";
import { buildReviewPrompt } from "../review/prompt.js";
import { resolveRules } from "../rules/resolve.js";
import { toFinding } from "./findings.js";
import type { MatrixCell } from "./matrix.js";
import type { ReviewPlan } from "./plan.js";
import type { ReviewEvent, TaskOutcome } from "./report.js";
import { executeTask } from "./task.js";

export interface JobResult {
  outcome: TaskOutcome;
  findings: Finding[];
  usage: Usage;
  warnings: string[];
}

export interface ExecuteOptions {
  runtime: AgentRuntime;
  taskTimeoutMs: number;
  relocate?: AnchorContext["relocate"] | undefined;
  emit: (event: ReviewEvent) => void;
  signal: AbortSignal;
}

// Runs one (bundle, reviewer) cell and anchors what it reports.
export async function runJob(
  job: MatrixCell,
  plan: ReviewPlan,
  options: ExecuteOptions,
): Promise<JobResult> {
  const { emit } = options;
  const files = job.bundle.files.map((f) => f.newPath);
  const prompt = buildReviewPrompt({
    reviewer: job.reviewer,
    changeRequest: plan.changeRequest,
    changedFiles: plan.selected,
    bundle: job.bundle.files,
    rules: resolveRules(files, plan.repoRules),
    guidelines: plan.guidelines,
  });

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
      defaultCategory: job.reviewer.category,
    },
  );

  const warnings = [...result.warnings];
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
    const anchor = await anchorFinding(reported, anchorContext);
    if (anchor.warning) warnings.push(`${job.taskId}: ${anchor.warning}`);
    if (!bundleFiles.has(anchor.file)) {
      outside += 1;
      continue;
    }
    const finding = toFinding(reported, job.reviewer.id, anchor);
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
  return { outcome, findings, usage: result.usage, warnings };
}
