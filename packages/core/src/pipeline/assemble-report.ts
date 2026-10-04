import { effortWarnings, resolveAgents } from "../agent/settings.js";
import { addUsage, emptyUsage, unpricedCalls } from "../agent/usage.js";
import type { Usage } from "../contracts.js";
import type { Finding, PriorReview, Severity } from "../domain.js";
import { type ReviewReport, summarizeAnchoring } from "../report/report.js";
import type { ReviewerDefinition } from "../review/reviewer.js";
import type { CheckStage } from "./check-stage.js";
import type { ExecuteStage, StageContext } from "./execute-stage.js";
import type { FilterStage } from "./filter-stage.js";
import { runProvenance } from "./provenance.js";

export interface RunFacts {
  runId: string;
  reviewers: readonly ReviewerDefinition[];
  prior: { review?: PriorReview; warning?: string };
  scopeNote?: NonNullable<ReviewReport["scope"]> | undefined;
}

export interface Stages {
  executed: ExecuteStage;
  filtered: FilterStage;
  checked: CheckStage;
}

export function assembleReport(run: RunFacts, stages: Stages, context: StageContext): ReviewReport {
  const report = reportBody(run, stages, context);
  const { options, plan, budget } = context;
  const { executed, filtered, checked } = stages;
  if (checked.judged.decisions) report.judgement = checked.judged.decisions;
  if (options.limits?.maxCostUsd !== undefined) {
    const reached = budget.exhausted()
      ? "total"
      : executed.reviewLimitReached()
        ? "review"
        : undefined;
    report.spendLimit = { usd: options.limits?.maxCostUsd, ...(reached ? { reached } : {}) };
  }
  report.anchoring = summarizeAnchoring(report.findings, executed.relocations.length);
  const agents = resolveAgents(run.reviewers, options);
  report.warnings.push(...effortWarnings(agents, options.runtime));
  if (options.identity?.provenance) {
    const { runtime, reviewerOverrides } = options;
    report.provenance = runProvenance(
      options.identity?.provenance,
      runtime,
      run.reviewers,
      agents,
      reviewerOverrides,
      plan.repoRules,
    );
  }
  if (run.prior.review) {
    const { fixed, notReproduced, notRechecked, unchanged, dismissed } = filtered.reconciled;
    report.rereview = { fixed, notReproduced, notRechecked, unchanged, dismissed };
  }
  if (plan.widened) {
    report.scope = {
      mode: "full",
      reason: `the risk tier rose from ${plan.widened.from} to ${plan.widened.to}, which adds reviewers`,
    };
  } else if (run.scopeNote) report.scope = run.scopeNote;
  if (run.prior.warning) report.warnings.push(run.prior.warning);
  return report;
}

function reportBody(
  run: RunFacts,
  { executed, filtered, checked }: Stages,
  { plan }: StageContext,
): ReviewReport {
  const { verification, judged } = checked;
  const calls = [...plan.usage, ...executed.usage(), ...checked.usage];
  return {
    runId: run.runId,
    changeRequest: plan.changeRequest,
    tier: plan.tier,
    verdict: judged.verdict,
    summary: filtered.nothingReviewed
      ? "Nothing was reviewed: no reviewer covered or finished any selected file."
      : judged.summary,
    coverage: filtered.coverage,
    bundles: plan.bundles.map((b) => ({ label: b.label, files: b.files.map((f) => f.newPath) })),
    tasks: [...executed.results.map((r) => r.outcome), ...filtered.imported.outcomes],
    skipped: executed.matrix.skipped,
    findings: sortFindings(judged.findings),
    // Counted before the judge: dropping or downgrading a critical nobody
    // could check must not turn an incomplete run into a clean one.
    unverifiedCriticals: countMissedCriticals(verification.kept, verification.missed),
    refuted: verification.refuted,
    remembered: filtered.remembered,
    usage: sumUsage(calls),
    warnings: [
      ...unpricedWarning(calls),
      ...plan.warnings,
      ...executed.warnings,
      ...filtered.warnings,
      ...checked.warnings,
    ],
  };
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
