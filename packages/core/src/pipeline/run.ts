import { type AnchorContext, anchorFinding } from "../anchor/anchor.js";
import {
  type Bundle,
  type BundlePolicy,
  bundleFiles,
  defaultBundlePolicy,
} from "../bundle/bundle.js";
import type { FileGrouper } from "../bundle/grouping.js";
import type { AgentRuntime, ReviewContext, Usage, VcsAdapter } from "../contracts.js";
import type { ChangeRequest, FileDiff, Finding, Severity } from "../domain.js";
import { buildReviewPrompt } from "../review/prompt.js";
import type { ReviewerDefinition } from "../review/reviewer.js";
import { correctnessReviewer } from "../review/reviewers/correctness.js";
import { parseRepoRules, REPO_RULES_PATH, type RepoRule } from "../rules/repo-rules.js";
import { resolveRules } from "../rules/resolve.js";
import {
  defaultSelectionPolicy,
  type FileDecision,
  type SelectionPolicy,
  selectFiles,
} from "../select/select.js";
import { triage } from "../triage.js";
import { dedupeFindings, toFinding } from "./findings.js";
import { runtimeGrouper } from "./helpers.js";
import { mapWithConcurrency } from "./pool.js";
import type { CoverageEntry, ReviewEvent, ReviewReport, TaskOutcome } from "./report.js";
import { executeTask } from "./task.js";
import { addUsage, emptyUsage } from "./usage.js";

export interface ReviewOptions {
  vcs: VcsAdapter;
  runtime: AgentRuntime;
  reviewers?: readonly ReviewerDefinition[];
  rules?: readonly RepoRule[];
  selection?: SelectionPolicy;
  bundling?: BundlePolicy;
  grouper?: FileGrouper;
  relocate?: AnchorContext["relocate"];
  concurrency?: number;
  taskTimeoutMs?: number;
  runTimeoutMs?: number;
  signal?: AbortSignal;
  onEvent?: (event: ReviewEvent) => void;
}

export const GUIDELINES_PATH = "AGENTS.md";

const DEFAULTS = { concurrency: 4, taskTimeoutMs: 10 * 60_000, runTimeoutMs: 25 * 60_000 };

interface Job {
  taskId: string;
  reviewer: ReviewerDefinition;
  bundle: Bundle;
}

interface JobResult {
  outcome: TaskOutcome;
  findings: Finding[];
  usage: Usage;
  warnings: string[];
}

interface RunState {
  options: ReviewOptions;
  emit: (event: ReviewEvent) => void;
  signal: AbortSignal;
  changeRequest: ChangeRequest;
  selected: FileDiff[];
  context: ReviewContext;
  guidelines: string | undefined;
  repoRules: RepoRule[];
}

export async function runReview(options: ReviewOptions): Promise<ReviewReport> {
  const emit = options.onEvent ?? (() => {});
  const timeout = AbortSignal.timeout(options.runTimeoutMs ?? DEFAULTS.runTimeoutMs);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  const { vcs } = options;
  const reviewers = options.reviewers ?? [correctnessReviewer];
  if (reviewers.length === 0) throw new Error("No reviewer is registered");

  const changeRequest = await vcs.getChangeRequest();
  emit({ type: "run_started", changeRequest });

  const diffs = await vcs.getDiff();
  const decisions = selectFiles(diffs, options.selection ?? defaultSelectionPolicy);
  const selected = decisions.filter((d) => d.selected).map((d) => d.diff);
  const tier = triage(selected);
  emit({
    type: "files_selected",
    selected: selected.length,
    excluded: diffs.length - selected.length,
    tier,
  });

  const [guidelines, fileRules] = await Promise.all([
    vcs.readFile(GUIDELINES_PATH),
    loadRepoRules(vcs),
  ]);
  const repoRules = [...(options.rules ?? []), ...fileRules];
  const helperUsage: Usage[] = [];
  const grouper =
    options.grouper ?? runtimeGrouper(options.runtime, signal, (u) => helperUsage.push(u));
  const bundled = await bundleFiles(selected, options.bundling ?? defaultBundlePolicy, grouper);
  emit({
    type: "files_bundled",
    strategy: bundled.strategy,
    bundles: bundled.bundles.length,
    warnings: bundled.warnings,
  });

  const context: ReviewContext = {
    readFile: (path) => vcs.readFile(path),
    readDiff: (path) => diffs.find((d) => d.newPath === path || d.oldPath === path)?.patch,
    searchCode: (literal) => vcs.searchCode(literal),
  };
  const state: RunState = {
    options,
    emit,
    signal,
    changeRequest,
    selected,
    context,
    guidelines,
    repoRules,
  };

  const jobs = bundled.bundles.flatMap((bundle, i) =>
    reviewers.map((reviewer) => ({ taskId: `${reviewer.id}-${i + 1}`, reviewer, bundle })),
  );
  const results = await mapWithConcurrency(
    jobs,
    options.concurrency ?? DEFAULTS.concurrency,
    (job) => runJob(job, state),
  );

  const report: ReviewReport = {
    changeRequest,
    tier,
    coverage: coverage(decisions, results),
    bundles: bundled.bundles.map((b) => ({ label: b.label, files: b.files.map((f) => f.newPath) })),
    tasks: results.map((r) => r.outcome),
    findings: sortFindings(dedupeFindings(results.flatMap((r) => r.findings))),
    usage: sumUsage([...helperUsage, ...results.map((r) => r.usage)]),
    warnings: [...bundled.warnings, ...results.flatMap((r) => r.warnings)],
  };
  emit({ type: "run_finished", report });
  return report;
}

async function runJob(job: Job, state: RunState): Promise<JobResult> {
  const { options, emit } = state;
  const files = job.bundle.files.map((f) => f.newPath);
  const prompt = buildReviewPrompt({
    reviewer: job.reviewer,
    changeRequest: state.changeRequest,
    changedFiles: state.selected,
    bundle: job.bundle.files,
    rules: resolveRules(files, state.repoRules),
    guidelines: state.guidelines,
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
      context: state.context,
      timeoutMs: options.taskTimeoutMs ?? DEFAULTS.taskTimeoutMs,
    },
    state.signal,
    {
      onProgress: (message) => emit({ type: "task_progress", taskId: job.taskId, message }),
      defaultCategory: job.reviewer.category,
    },
  );

  const warnings = [...result.warnings];
  const findings: Finding[] = [];
  const anchorContext: AnchorContext = {
    diffs: state.selected,
    readNewFile: state.context.readFile,
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

async function loadRepoRules(vcs: VcsAdapter): Promise<RepoRule[]> {
  const text = await vcs.readFile(REPO_RULES_PATH);
  return text === undefined ? [] : parseRepoRules(text);
}

function coverage(
  decisions: readonly FileDecision[],
  results: readonly JobResult[],
): CoverageEntry[] {
  const failed = new Set(
    results.filter((r) => r.outcome.status !== "completed").flatMap((r) => r.outcome.files),
  );
  return decisions.map((d): CoverageEntry => {
    const path = d.diff.newPath;
    if (!d.selected) return { path, status: "excluded", reason: d.reason };
    return { path, status: failed.has(path) ? "failed" : "reviewed" };
  });
}

const SEVERITY_ORDER: Record<Severity, number> = { critical: 0, warning: 1, suggestion: 2 };

function sortFindings(findings: Finding[]): Finding[] {
  return findings.sort(
    (a, b) =>
      SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
      a.file.localeCompare(b.file) ||
      (a.lineRange?.start ?? 0) - (b.lineRange?.start ?? 0),
  );
}

function sumUsage(usages: readonly Usage[]): Usage {
  return usages.reduce(addUsage, emptyUsage());
}
