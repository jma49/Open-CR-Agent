import { effortWarnings, resolveAgents } from "../agent/settings.js";
import { addUsage, emptyUsage, unpricedCalls } from "../agent/usage.js";
import type { Usage } from "../contracts.js";
import { projectDocUses } from "../docs/project-docs.js";
import type { Finding, Severity } from "../domain.js";
import type { LearningUse } from "../knowledge/learning.js";
import { selectInline } from "../report/inline.js";
import { nothingReviewedSummary, type ReviewReport, summarizeAnchoring } from "../report/report.js";
import type { ReviewerDefinition } from "../review/reviewer.js";
import { evidenceUses } from "../sarif/evidence.js";
import type { CheckStage } from "./check-stage.js";
import type { ExecuteStage, StageContext } from "./execute-stage.js";
import type { FilterStage } from "./filter-stage.js";
import type { FixStage } from "./fix-stage.js";
import type { MergeChecksStage } from "./merge-checks-stage.js";
import type { ReviewPlan } from "./plan.js";
import { runProvenance } from "./provenance.js";
import type { WalkthroughStage } from "./walkthrough-stage.js";

export interface RunFacts {
  runId: string;
  reviewers: readonly ReviewerDefinition[];
}

export interface Stages {
  executed: ExecuteStage;
  filtered: FilterStage;
  checked: CheckStage;
  fixed: FixStage;
  walkthrough: WalkthroughStage;
  mergeChecks: MergeChecksStage;
}

export function assembleReport(run: RunFacts, stages: Stages, context: StageContext): ReviewReport {
  const report = reportBody(run, stages, context);
  const { options, plan, spendLimit } = context;
  const { executed, filtered, checked } = stages;
  if (checked.judged.decisions) report.judgement = checked.judged.decisions;
  if (stages.fixed.summary) report.fixes = stages.fixed.summary;
  if (stages.walkthrough.walkthrough) report.walkthrough = stages.walkthrough.walkthrough;
  if (options.mergeChecks?.length) report.mergeChecks = stages.mergeChecks.results;
  const limit = spendLimit.status();
  if (limit) report.spendLimit = limit;
  const inline = options.inline && selectInline(report.findings, options.inline);
  if (inline) report.inline = inline;
  report.anchoring = summarizeAnchoring(report.findings, executed.relocations.length);
  if (options.runtime.agent) report.agent = options.runtime.agent;
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
  if (plan.prior.review) {
    const { fixed, notReproduced, notRechecked, unchanged, dismissed } = filtered.reconciled;
    report.rereview = { fixed, notReproduced, notRechecked, unchanged, dismissed };
  }
  const learnings = learningUses(plan);
  if (learnings.length > 0) report.learnings = learnings;
  if (plan.linkedTasks) report.linkedTasks = plan.linkedTasks.uses;
  const docs = projectDocUses(
    plan.docSections,
    plan.bundles.map((b) => ({ label: b.label, files: b.files.map((f) => f.newPath) })),
  );
  if (docs.length > 0) report.projectDocs = docs;
  const evidence = evidenceUses(plan.evidence, plan.bundles);
  if (evidence.length > 0) report.analyzerEvidence = evidence;
  if (plan.scope) report.scope = plan.scope;
  if (plan.prior.warning) report.warnings.push(plan.prior.warning);
  return report;
}

function reportBody(
  run: RunFacts,
  { executed, filtered, checked, fixed, walkthrough, mergeChecks }: Stages,
  { plan }: StageContext,
): ReviewReport {
  const { verification, judged } = checked;
  const calls = [
    ...plan.usage,
    ...executed.usage(),
    ...walkthrough.usage,
    ...mergeChecks.usage,
    ...checked.usage,
    ...fixed.usage,
  ];
  const tasks = [...executed.results.map((r) => r.outcome), ...filtered.imported.outcomes];
  return {
    runId: run.runId,
    changeRequest: plan.changeRequest,
    tier: plan.tier,
    verdict: judged.verdict,
    summary: filtered.nothingReviewed ? nothingReviewedSummary(tasks) : judged.summary,
    coverage: filtered.coverage,
    bundles: plan.bundles.map((b) => ({ label: b.label, files: b.files.map((f) => f.newPath) })),
    tasks,
    skipped: executed.matrix.skipped,
    findings: sortFindings(fixed.findings),
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
      ...walkthrough.warnings,
      ...mergeChecks.warnings,
      ...checked.warnings,
      ...fixed.warnings,
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

function learningUses(plan: ReviewPlan): LearningUse[] {
  const uses = new Map<string, LearningUse>();
  for (const bundle of plan.bundles) {
    for (const l of plan.learnings(bundle.files).selected) {
      const use = uses.get(l.id) ?? {
        id: l.id,
        title: l.title,
        critical: l.critical,
        ...(l.source ? { source: l.source } : {}),
        bundles: [],
      };
      use.bundles.push(bundle.label);
      uses.set(l.id, use);
    }
  }
  return [...uses.values()].sort((a, b) => (a.id < b.id ? -1 : 1));
}
