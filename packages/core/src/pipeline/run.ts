import type { AnchorContext, RelocationRequest } from "../anchor/anchor.js";
import { runtimeRelocator } from "../anchor/relocate.js";
import type { BundlePolicy } from "../bundle/bundle.js";
import type { FileGrouper } from "../bundle/grouping.js";
import type { AgentRuntime, Usage, VcsAdapter } from "../contracts.js";
import type { Finding, PriorReview, Severity } from "../domain.js";
import { errorMessage } from "../errors.js";
import { judgeFindings } from "../judge/judge.js";
import { applyMemory, type MemoryEntry } from "../memory/memory.js";
import { priorCodePresence } from "../rereview/presence.js";
import { reconcile, stillOpen } from "../rereview/reconcile.js";
import type { ReviewerDefinition } from "../review/reviewer.js";
import { correctnessReviewer } from "../review/reviewers/correctness.js";
import type { RepoRule } from "../rules/repo-rules.js";
import type { FileDecision, SelectionPolicy } from "../select/select.js";
import { markUnchecked, verifyFindings } from "../verify/verify.js";
import { SpendLimitReached, spendTracker } from "./budget.js";
import { type JobResult, runJob } from "./execute.js";
import { dedupeFindings } from "./findings.js";
import { DEFAULT_MAX_TASKS, type MatrixCell, planTasks, type ReviewerOverrides } from "./matrix.js";
import { planReview } from "./plan.js";
import { mapWithConcurrency } from "./pool.js";
import {
  type CoverageEntry,
  coverageGaps,
  type ReviewEvent,
  type ReviewReport,
  summarizeAnchoring,
  type TaskOutcome,
} from "./report.js";
import { addUsage, emptyUsage, unpricedCalls } from "./usage.js";

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
  // Replaces the runtime's light-model relocation (tests); `false` turns
  // relocation off.
  relocate?: AnchorContext["relocate"] | false;
  concurrency?: number;
  taskTimeoutMs?: number;
  runTimeoutMs?: number;
  // How long a cut-off task may still deliver its usage and findings.
  abortGraceMs?: number;
  // Fact-check findings before reporting them (default true).
  verify?: boolean;
  // Merge, filter and recalibrate findings across reviewers on the top tier (default true).
  judge?: boolean;
  // Review tasks stop starting at REVIEW_BUDGET_SHARE of this; Verify and
  // Judge use the rest, and are skipped (findings left unchecked) once it is
  // gone. Calls already running finish, so a run can end slightly above it.
  maxCostUsd?: number;
  // At most this many review tasks (DEFAULT_MAX_TASKS); the rest are skipped
  // and their files reported as not reviewed.
  maxTasks?: number;
  // Review every file even when the platform reports what changed since the
  // previous review.
  fullReview?: boolean;
  // Recall over cost: every reviewer at every tier, two samples per cell, and
  // findings the judge would drop kept as low confidence.
  ultra?: boolean;
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

  const prior = await loadPriorReview(options.vcs);
  const scope = reviewScope(prior.review, options.fullReview === true);
  const plan = await planReview(
    scope.only
      ? {
          ...options,
          reviewOnly: scope.only,
          ...(prior.review?.tier ? { priorTier: prior.review.tier } : {}),
        }
      : options,
    emit,
    signal,
  );

  const matrix = planTasks(plan.bundles, reviewers, plan.tier, options.reviewerOverrides, {
    ultra: options.ultra === true,
    ...(options.maxTasks !== undefined ? { maxTasks: options.maxTasks } : {}),
    hasGuidelines: Boolean(plan.guidelines?.trim()),
  });
  const limited = matrix.skipped.filter((s) => s.reason === "task_limit").length;
  if (limited > 0) {
    plan.warnings.push(
      `task limit of ${options.maxTasks ?? DEFAULT_MAX_TASKS} reached: ${limited} review task(s) skipped; their files are reported as not reviewed`,
    );
  }
  emit({ type: "matrix_planned", tasks: matrix.cells.length, skipped: matrix.skipped });
  const relocationUsage: Usage[] = [];
  const budget = spendTracker(options.maxCostUsd, plan.usage);
  const relocator =
    options.relocate === false
      ? undefined
      : (options.relocate ??
        runtimeRelocator(options.runtime, signal, (u) => {
          relocationUsage.push(u);
          budget.add(u);
        }));
  // Tasks report spend while they run, so the one that uses up the review
  // share stops every task still running, not only the ones not yet started.
  const spendLimit = new AbortController();
  const spend = (usage: Usage) => {
    budget.add(usage);
    if (budget.reviewExhausted() && !spendLimit.signal.aborted) {
      spendLimit.abort(new SpendLimitReached(options.maxCostUsd ?? 0));
    }
  };
  const execute = {
    runtime: options.runtime,
    taskTimeoutMs: options.taskTimeoutMs ?? DEFAULTS.taskTimeoutMs,
    abortGraceMs: options.abortGraceMs,
    // Past the spend limit a quote that does not match stays file-level.
    relocate:
      relocator &&
      (async (request: RelocationRequest) => (budget.exhausted() ? undefined : relocator(request))),
    ultra: options.ultra === true,
    plans: new Map(),
    emit,
    onUsage: spend,
    signal: AbortSignal.any([signal, spendLimit.signal]),
  };
  // Tasks that never started leave their files unreviewed, not failed.
  const notStarted = new Set<string>();
  let unaffordable = 0;
  const results = await mapWithConcurrency(
    matrix.cells,
    options.concurrency ?? DEFAULTS.concurrency,
    async (cell) => {
      // Once the run is cancelled or timed out, remaining cells are not started.
      if (signal.aborted) {
        notStarted.add(cell.taskId);
        return skipCell(cell, "run cancelled before this task started", emit);
      }
      if (budget.reviewExhausted()) {
        notStarted.add(cell.taskId);
        unaffordable += 1;
        return skipCell(cell, `spend limit of $${options.maxCostUsd} reached`, emit);
      }
      return runJob(cell, plan, execute);
    },
  );
  if (unaffordable > 0) {
    plan.warnings.push(
      `spend limit of $${options.maxCostUsd} reached: ${unaffordable} review task(s) did not start; their files are reported as not reviewed`,
    );
  }

  // Memory and the previous review filter first, so Verify and Judge are not
  // paid for findings that will not be reported, and a person's dismissal
  // keeps a finding out of the verdict whatever the models say.
  const concurrency = options.concurrency ?? DEFAULTS.concurrency;
  const found = dedupeFindings(results.flatMap((r) => r.findings));
  const fileCoverage = coverage(
    plan.decisions,
    results,
    plan.unchanged,
    matrix.limited ?? [],
    notStarted,
  );
  const remembered = applyMemory(found, plan.memory);
  const reported = new Set(found.map((f) => f.fingerprint));
  const priorReview = withoutRemembered(prior.review, plan.memory);
  const reconciled = reconcile({
    findings: remembered.kept,
    reported,
    prior: priorReview,
    coverage: fileCoverage,
    stillPresent: await priorCodePresence(priorReview, reported, plan.context.readFile),
  });

  const verification =
    options.verify === false
      ? {
          checked: 0,
          kept: markUnchecked(reconciled.findings),
          refuted: [],
          missed: [],
          usage: [],
          warnings: [],
        }
      : await verifyFindings(reconciled.findings, {
          runtime: options.runtime,
          diffs: plan.selected,
          context: plan.context,
          signal,
          concurrency,
          budget,
        });
  if (verification.checked > 0) {
    emit({
      type: "verification_finished",
      checked: verification.checked,
      refuted: verification.refuted,
    });
  }

  const judgeWanted = options.judge !== false && verification.kept.length > 0;
  const judgeAffordable = !budget.exhausted();
  const judged = await judgeFindings(verification.kept, {
    runtime: options.runtime,
    changeRequest: plan.changeRequest,
    tier: plan.tier,
    signal,
    enabled: judgeWanted && judgeAffordable,
    keepDropped: options.ultra === true,
    carried: stillOpen(reconciled),
  });
  if (judgeWanted && !judgeAffordable) {
    judged.warnings.push(`spend limit of $${options.maxCostUsd} reached: findings were not judged`);
  }
  const { nothingReviewed } = coverageGaps({
    coverage: fileCoverage,
    tasks: results.map((r) => r.outcome),
  });
  if (!nothingReviewed) {
    emit(
      judged.decisions
        ? { type: "judge_finished", verdict: judged.verdict, judgement: judged.decisions }
        : { type: "judge_finished", verdict: judged.verdict },
    );
  }

  const calls = [
    ...plan.usage,
    ...results.map((r) => r.usage),
    ...relocationUsage,
    ...verification.usage,
    ...judged.usage,
  ];
  const report: ReviewReport = {
    changeRequest: plan.changeRequest,
    tier: plan.tier,
    verdict: judged.verdict,
    summary: nothingReviewed
      ? "Nothing was reviewed: no reviewer covered or finished any selected file."
      : judged.summary,
    coverage: fileCoverage,
    bundles: plan.bundles.map((b) => ({ label: b.label, files: b.files.map((f) => f.newPath) })),
    tasks: results.map((r) => r.outcome),
    skipped: matrix.skipped,
    findings: sortFindings(judged.findings),
    // Counted before the judge: dropping or downgrading a critical nobody
    // could check must not turn an incomplete run into a clean one.
    unverifiedCriticals: countMissedCriticals(verification.kept, verification.missed),
    refuted: verification.refuted,
    remembered: remembered.remembered,
    usage: sumUsage(calls),
    warnings: [
      ...unpricedWarning(calls),
      ...plan.warnings,
      ...results.flatMap((r) => r.warnings),
      ...verification.warnings,
      ...judged.warnings,
    ],
  };
  if (judged.decisions) report.judgement = judged.decisions;
  if (options.maxCostUsd !== undefined) {
    const reached = budget.exhausted()
      ? "total"
      : spendLimit.signal.aborted || unaffordable > 0
        ? "review"
        : undefined;
    report.spendLimit = { usd: options.maxCostUsd, ...(reached ? { reached } : {}) };
  }
  report.anchoring = summarizeAnchoring(report.findings, relocationUsage.length);
  if (prior.review) {
    report.rereview = {
      fixed: reconciled.fixed,
      notReproduced: reconciled.notReproduced,
      notRechecked: reconciled.notRechecked,
      unchanged: reconciled.unchanged,
      dismissed: reconciled.dismissed,
    };
  }
  if (plan.widened) {
    report.scope = {
      mode: "full",
      reason: `the risk tier rose from ${plan.widened.from} to ${plan.widened.to}, which adds reviewers`,
    };
  } else if (scope.note) report.scope = scope.note;
  if (prior.warning) report.warnings.push(prior.warning);
  emit({ type: "run_finished", report });
  return report;
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
  };
  emit({ type: "task_finished", outcome });
  return { outcome, findings: [], usage: emptyUsage(), warnings: [] };
}

// An earlier finding the team has since accepted is no longer open.
function withoutRemembered(
  review: PriorReview | undefined,
  memory: readonly MemoryEntry[],
): PriorReview | undefined {
  if (!review) return undefined;
  const accepted = new Set(memory.map((e) => e.fingerprint));
  // Everything else the earlier review carries (replies, tier, head) stays.
  return { ...review, findings: review.findings.filter((f) => !accepted.has(f.fingerprint)) };
}

// Review only what changed since the earlier review when the platform can
// tell; otherwise everything, with the reason in the report.
function reviewScope(
  review: PriorReview | undefined,
  full: boolean,
): { only?: ReadonlySet<string>; note?: NonNullable<ReviewReport["scope"]> } {
  if (!review) return {};
  if (full) return { note: { mode: "full", reason: "a full review was requested" } };
  if (review.changedSince) {
    return {
      only: new Set(review.changedSince.files),
      note: { mode: "incremental", since: review.changedSince.head },
    };
  }
  const reason = review.fullReviewReason ?? "the platform cannot tell what changed since";
  return { note: { mode: "full", reason } };
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
  unchanged: ReadonlySet<string>,
  limited: readonly MatrixCell[],
  notStarted: ReadonlySet<string>,
): CoverageEntry[] {
  // A file is reviewed when every reviewer assigned to it finished at least
  // one of its tasks: under --ultra one completed sample is enough. A
  // reviewer whose task failed makes the file "failed"; one whose task never
  // started (the task or spend limit, a cancelled run) makes it "unreviewed".
  const done = new Map<string, boolean>();
  const ran = new Set<string>();
  const key = (reviewer: string, file: string) => `${reviewer}\0${file}`;
  for (const { outcome } of results) {
    const started = !notStarted.has(outcome.taskId);
    for (const file of outcome.files) {
      const k = key(outcome.reviewer, file);
      if (started) ran.add(k);
      done.set(k, done.get(k) === true || outcome.status === "completed");
    }
  }
  for (const cell of limited) {
    for (const f of cell.bundle.files) {
      const k = key(cell.reviewer.id, f.newPath);
      if (!done.has(k)) done.set(k, false);
    }
  }
  const status = new Map<string, "reviewed" | "failed" | "unreviewed">();
  for (const [k, completed] of done) {
    const file = k.split("\0")[1] as string;
    const now = completed ? "reviewed" : ran.has(k) ? "failed" : "unreviewed";
    const before = status.get(file);
    // failed outranks unreviewed, which outranks reviewed.
    if (!before || now === "failed" || (now === "unreviewed" && before === "reviewed")) {
      status.set(file, now);
    }
  }
  return decisions.map((d): CoverageEntry => {
    const path = d.diff.newPath;
    if (!d.selected) return { path, status: "excluded", reason: d.reason };
    if (unchanged.has(path)) return { path, status: "unchanged" };
    return { path, status: status.get(path) ?? "unreviewed" };
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

function unpricedWarning(calls: readonly Usage[]): string[] {
  const unpriced = unpricedCalls(calls);
  return unpriced > 0
    ? [
        `${unpriced} model call(s) used tokens but reported no cost: their model has no price, so the reported cost and the spend limit do not count them`,
      ]
    : [];
}

function sumUsage(usages: readonly Usage[]): Usage {
  return usages.reduce(addUsage, emptyUsage());
}

// Low-confidence findings do not count toward the verdict, so their missed
// verification does not make the run incomplete either.
function countMissedCriticals(findings: readonly Finding[], missed: readonly string[]): number {
  const set = new Set(missed);
  return findings.filter(
    (f) =>
      f.severity === "critical" &&
      !f.lowConfidence &&
      f.verification === "unchecked" &&
      set.has(f.fingerprint),
  ).length;
}
