import type { AnchorContext } from "../anchor/anchor.js";
import type { BundlePolicy } from "../bundle/bundle.js";
import type { FileGrouper } from "../bundle/grouping.js";
import type { AgentRuntime, Usage, VcsAdapter } from "../contracts.js";
import type { Finding, Severity } from "../domain.js";
import type { ReviewerDefinition } from "../review/reviewer.js";
import { correctnessReviewer } from "../review/reviewers/correctness.js";
import type { RepoRule } from "../rules/repo-rules.js";
import type { FileDecision, SelectionPolicy } from "../select/select.js";
import { type JobResult, runJob } from "./execute.js";
import { dedupeFindings } from "./findings.js";
import { planMatrix, type ReviewerOverrides } from "./matrix.js";
import { planReview } from "./plan.js";
import { mapWithConcurrency } from "./pool.js";
import type { CoverageEntry, ReviewEvent, ReviewReport } from "./report.js";
import { addUsage, emptyUsage } from "./usage.js";

export { GUIDELINES_PATH } from "./plan.js";

export interface ReviewOptions {
  vcs: VcsAdapter;
  runtime: AgentRuntime;
  reviewers?: readonly ReviewerDefinition[];
  reviewerOverrides?: ReviewerOverrides;
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

const DEFAULTS = { concurrency: 4, taskTimeoutMs: 10 * 60_000, runTimeoutMs: 25 * 60_000 };

// Plan (deterministic stages) → execute (one agent task per cell) → report.
export async function runReview(options: ReviewOptions): Promise<ReviewReport> {
  const emit = options.onEvent ?? (() => {});
  const timeout = AbortSignal.timeout(options.runTimeoutMs ?? DEFAULTS.runTimeoutMs);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  const reviewers = options.reviewers ?? [correctnessReviewer];
  if (reviewers.length === 0) throw new Error("No reviewer is registered");

  const plan = await planReview(options, emit, signal);

  const matrix = planMatrix(plan.bundles, reviewers, plan.tier, options.reviewerOverrides);
  emit({ type: "matrix_planned", tasks: matrix.cells.length, skipped: matrix.skipped });
  const execute = {
    runtime: options.runtime,
    taskTimeoutMs: options.taskTimeoutMs ?? DEFAULTS.taskTimeoutMs,
    relocate: options.relocate,
    emit,
    signal,
  };
  const results = await mapWithConcurrency(
    matrix.cells,
    options.concurrency ?? DEFAULTS.concurrency,
    (job) => runJob(job, plan, execute),
  );

  const report: ReviewReport = {
    changeRequest: plan.changeRequest,
    tier: plan.tier,
    coverage: coverage(plan.decisions, results),
    bundles: plan.bundles.map((b) => ({ label: b.label, files: b.files.map((f) => f.newPath) })),
    tasks: results.map((r) => r.outcome),
    skipped: matrix.skipped,
    findings: sortFindings(dedupeFindings(results.flatMap((r) => r.findings))),
    usage: sumUsage([...plan.usage, ...results.map((r) => r.usage)]),
    warnings: [...plan.warnings, ...results.flatMap((r) => r.warnings)],
  };
  emit({ type: "run_finished", report });
  return report;
}

function coverage(
  decisions: readonly FileDecision[],
  results: readonly JobResult[],
): CoverageEntry[] {
  const failed = new Set(
    results.filter((r) => r.outcome.status !== "completed").flatMap((r) => r.outcome.files),
  );
  const assigned = new Set(results.flatMap((r) => r.outcome.files));
  return decisions.map((d): CoverageEntry => {
    const path = d.diff.newPath;
    if (!d.selected) return { path, status: "excluded", reason: d.reason };
    if (!assigned.has(path)) return { path, status: "unreviewed" };
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
