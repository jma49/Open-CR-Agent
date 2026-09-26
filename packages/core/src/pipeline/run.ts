import type { AnchorContext } from "../anchor/anchor.js";
import type { BundlePolicy } from "../bundle/bundle.js";
import type { FileGrouper } from "../bundle/grouping.js";
import type { AgentRuntime, Usage, VcsAdapter } from "../contracts.js";
import type { Finding, PriorReview, Severity } from "../domain.js";
import { errorMessage } from "../errors.js";
import { judgeFindings } from "../judge/judge.js";
import { reconcile } from "../rereview/reconcile.js";
import type { ReviewerDefinition } from "../review/reviewer.js";
import { correctnessReviewer } from "../review/reviewers/correctness.js";
import type { RepoRule } from "../rules/repo-rules.js";
import type { FileDecision, SelectionPolicy } from "../select/select.js";
import { verifyFindings } from "../verify/verify.js";
import { type JobResult, runJob } from "./execute.js";
import { dedupeFindings } from "./findings.js";
import { type MatrixCell, planMatrix, type ReviewerOverrides } from "./matrix.js";
import { planReview } from "./plan.js";
import { mapWithConcurrency } from "./pool.js";
import type { CoverageEntry, ReviewEvent, ReviewReport, TaskOutcome } from "./report.js";
import { addUsage, emptyUsage } from "./usage.js";

export { GUIDELINES_PATH } from "./plan.js";

export interface ReviewOptions {
  vcs: VcsAdapter;
  runtime: AgentRuntime;
  reviewers?: readonly ReviewerDefinition[];
  reviewerOverrides?: ReviewerOverrides;
  rules?: readonly RepoRule[];
  // Where AGENTS.md and .ocra/rules.json are read from. Defaults to the
  // revision under review; pull request reviews pass the trusted base.
  readTrusted?: (path: string) => Promise<string | undefined>;
  selection?: SelectionPolicy;
  bundling?: BundlePolicy;
  grouper?: FileGrouper;
  relocate?: AnchorContext["relocate"];
  concurrency?: number;
  taskTimeoutMs?: number;
  runTimeoutMs?: number;
  // Fact-check findings before reporting them (default true).
  verify?: boolean;
  // Merge, filter and recalibrate findings across reviewers on the top tier (default true).
  judge?: boolean;
  // Stop starting review tasks once reported spend reaches this; tasks
  // already running finish, so a run can end slightly above it.
  maxCostUsd?: number;
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
  const prior = await loadPriorReview(options.vcs);

  const matrix = planMatrix(plan.bundles, reviewers, plan.tier, options.reviewerOverrides);
  emit({ type: "matrix_planned", tasks: matrix.cells.length, skipped: matrix.skipped });
  const execute = {
    runtime: options.runtime,
    taskTimeoutMs: options.taskTimeoutMs ?? DEFAULTS.taskTimeoutMs,
    relocate: options.relocate,
    emit,
    signal,
  };
  const budget = spendTracker(options.maxCostUsd, plan.usage);
  const results = await mapWithConcurrency(
    matrix.cells,
    options.concurrency ?? DEFAULTS.concurrency,
    async (cell) => {
      if (budget.exhausted()) return budget.skip(cell, emit);
      const result = await runJob(cell, plan, execute);
      budget.add(result.usage);
      return result;
    },
  );

  const concurrency = options.concurrency ?? DEFAULTS.concurrency;
  const found = dedupeFindings(results.flatMap((r) => r.findings));
  const verification =
    options.verify === false || budget.exhausted()
      ? { checked: 0, kept: found, refuted: [], usage: [], warnings: [] }
      : await verifyFindings(found, {
          runtime: options.runtime,
          diffs: plan.selected,
          context: plan.context,
          signal,
          concurrency,
        });
  if (verification.checked > 0) {
    emit({
      type: "verification_finished",
      checked: verification.checked,
      refuted: verification.refuted,
    });
  }

  // Compared with the previous review before judging, so findings a person
  // dismissed neither reach the judge nor count towards the verdict.
  const fileCoverage = coverage(plan.decisions, results);
  const reconciled = reconcile(verification.kept, prior.review, fileCoverage);

  const judged = await judgeFindings(reconciled.findings, {
    runtime: options.runtime,
    changeRequest: plan.changeRequest,
    tier: plan.tier,
    signal,
    enabled: options.judge !== false && !budget.exhausted(),
  });
  emit(
    judged.decisions
      ? { type: "judge_finished", verdict: judged.verdict, judgement: judged.decisions }
      : { type: "judge_finished", verdict: judged.verdict },
  );

  const report: ReviewReport = {
    changeRequest: plan.changeRequest,
    tier: plan.tier,
    verdict: judged.verdict,
    summary:
      results.length > 0 && results.every((r) => r.outcome.status !== "completed")
        ? "Nothing was reviewed: no review task completed."
        : judged.summary,
    coverage: fileCoverage,
    bundles: plan.bundles.map((b) => ({ label: b.label, files: b.files.map((f) => f.newPath) })),
    tasks: results.map((r) => r.outcome),
    skipped: matrix.skipped,
    findings: sortFindings(judged.findings),
    refuted: verification.refuted,
    usage: sumUsage([
      ...plan.usage,
      ...results.map((r) => r.usage),
      ...verification.usage,
      ...judged.usage,
    ]),
    warnings: [
      ...plan.warnings,
      ...results.flatMap((r) => r.warnings),
      ...verification.warnings,
      ...judged.warnings,
    ],
  };
  if (judged.decisions) report.judgement = judged.decisions;
  if (prior.review) {
    report.rereview = {
      fixed: reconciled.fixed,
      notRechecked: reconciled.notRechecked,
      dismissed: reconciled.dismissed,
    };
  }
  if (prior.warning) report.warnings.push(prior.warning);
  emit({ type: "run_finished", report });
  return report;
}

function spendTracker(maxCostUsd: number | undefined, initial: readonly Usage[]) {
  let spent = initial.reduce((sum, u) => sum + u.costUsd, 0);
  const exhausted = () => maxCostUsd !== undefined && spent >= maxCostUsd;
  return {
    exhausted,
    add(usage: Usage) {
      spent += usage.costUsd;
    },
    skip(cell: MatrixCell, emit: (event: ReviewEvent) => void): JobResult {
      const outcome: TaskOutcome = {
        taskId: cell.taskId,
        reviewer: cell.reviewer.id,
        bundle: cell.bundle.label,
        files: cell.bundle.files.map((f) => f.newPath),
        status: "cancelled",
        error: `spend limit of $${maxCostUsd} reached`,
        findings: 0,
        durationMs: 0,
      };
      emit({ type: "task_finished", outcome });
      return { outcome, findings: [], usage: emptyUsage(), warnings: [] };
    },
  };
}

// A missing earlier review only costs the comparison, never the review.
async function loadPriorReview(
  vcs: VcsAdapter,
): Promise<{ review?: PriorReview; warning?: string }> {
  try {
    const review = await vcs.getPriorReview();
    return review ? { review } : {};
  } catch (error) {
    return { warning: `could not load the previous review: ${errorMessage(error)}` };
  }
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
