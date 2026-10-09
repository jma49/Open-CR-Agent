import type { z } from "zod";
import type { AppliedSampling, Usage } from "../contracts.js";
import type { ChangeRequest, Finding, PriorFinding } from "../domain.js";
import type { JudgeDecisions } from "../judge/judge.js";
import type { SkippedCell } from "../matrix/matrix.js";
import type { RememberedEntry } from "../memory/memory.js";
import type { RefutedFinding } from "../verify/verify.js";
import { REPORT_VERSION, type reportOutputSchema } from "./output-schema.js";
import type { AgentProvenance, RunProvenance } from "./provenance.js";
import type { AnchoringSummary, CoverageEntry, ReviewReport, TaskOutcome } from "./report.js";

// The published report is what its schema says, so the type cannot drift
// from the validator or the JSON Schema. Domain values reach it only through
// the mappers below, field by field: a field added to a domain type stays
// out of the report until the schema and its mapper take it.
export type ReportOutput = z.output<typeof reportOutputSchema>;
export type OutputFinding = ReportOutput["findings"][number];
export type OutputPriorFinding = NonNullable<ReportOutput["rereview"]>["fixed"][number];

type Output<K extends keyof ReportOutput> = NonNullable<ReportOutput[K]>;

export function toReportOutput(report: ReviewReport): ReportOutput {
  const output: ReportOutput = {
    version: REPORT_VERSION,
    runId: report.runId,
    changeRequest: outputChangeRequest(report.changeRequest),
    tier: report.tier,
    verdict: report.verdict,
    summary: report.summary,
    coverage: report.coverage.map(outputCoverage),
    findings: report.findings.map(outputFinding),
    unverifiedCriticals: report.unverifiedCriticals,
    refuted: report.refuted.map(outputRefuted),
    remembered: report.remembered.map(outputRemembered),
    tasks: report.tasks.map(outputTask),
    skipped: report.skipped.map(outputSkipped),
    bundles: report.bundles.map((b) => ({ label: b.label, files: [...b.files] })),
    usage: outputUsage(report.usage),
    warnings: [...report.warnings],
  };
  if (report.scope) output.scope = outputScope(report.scope);
  if (report.judgement) output.judgement = outputJudgement(report.judgement);
  if (report.anchoring) output.anchoring = outputAnchoring(report.anchoring);
  if (report.spendLimit) output.spendLimit = outputSpendLimit(report.spendLimit);
  if (report.provenance) output.provenance = outputProvenance(report.provenance);
  if (report.rereview) {
    const r = report.rereview;
    output.rereview = {
      fixed: r.fixed.map(outputPrior),
      notReproduced: r.notReproduced.map(outputPrior),
      notRechecked: r.notRechecked.map(outputPrior),
      unchanged: r.unchanged.map(outputPrior),
      dismissed: r.dismissed.map(outputPrior),
    };
  }
  return output;
}

function outputChangeRequest(c: ChangeRequest): Output<"changeRequest"> {
  return {
    id: c.id,
    title: c.title,
    description: c.description,
    baseSha: c.baseSha,
    headSha: c.headSha,
    ...(c.override ? { override: { by: c.override.by, reason: c.override.reason } } : {}),
  };
}

function outputCoverage(c: CoverageEntry): Output<"coverage">[number] {
  if (c.status === "excluded") return { path: c.path, status: c.status, reason: c.reason };
  if (c.status === "incomplete") return { path: c.path, status: c.status, ended: c.ended };
  return { path: c.path, status: c.status };
}

function outputFinding(f: Finding): OutputFinding {
  const output: OutputFinding = {
    fingerprint: f.fingerprint,
    reviewer: f.reviewer,
    category: f.category,
    severity: f.severity,
    verification: f.verification ?? "unchecked",
    file: f.file,
    inDiff: f.anchor.inDiff,
    status: f.status === "unfixed" ? "unfixed" : "new",
    title: f.title,
    body: f.body,
    evidence: f.evidence,
    code: f.existingCode,
  };
  if (f.lineRange) output.lines = { start: f.lineRange.start, end: f.lineRange.end };
  if (f.suggestion !== undefined) output.suggestion = f.suggestion;
  if (f.fix) {
    output.fix = {
      startLine: f.fix.startLine,
      endLine: f.fix.endLine,
      replacement: f.fix.replacement,
    };
  }
  if (f.lowConfidence) output.lowConfidence = true;
  output.provenance =
    f.provenance.model === undefined
      ? { task: f.provenance.task }
      : { task: f.provenance.task, model: f.provenance.model };
  return output;
}

function outputRefuted(r: RefutedFinding): Output<"refuted">[number] {
  return { fingerprint: r.fingerprint, file: r.file, title: r.title, reason: r.reason };
}

function outputRemembered(e: RememberedEntry): Output<"remembered">[number] {
  return {
    fingerprint: e.fingerprint,
    file: e.file,
    title: e.title,
    reason: e.reason,
    ...(e.added === undefined ? {} : { added: e.added }),
    source: e.source,
  };
}

function outputTask(t: TaskOutcome): Output<"tasks">[number] {
  return {
    taskId: t.taskId,
    reviewer: t.reviewer,
    bundle: t.bundle,
    files: [...t.files],
    status: t.status,
    findings: t.findings,
    durationMs: t.durationMs,
    usage: outputUsage(t.usage),
    ...(t.error === undefined ? {} : { error: t.error }),
    ...(t.ended === undefined ? {} : { ended: t.ended }),
    ...(t.reusedFrom === undefined ? {} : { reusedFrom: t.reusedFrom }),
  };
}

function outputSkipped(s: SkippedCell): Output<"skipped">[number] {
  return { reviewer: s.reviewer, bundle: s.bundle, reason: s.reason };
}

function outputUsage(u: Usage): Output<"usage"> {
  return {
    inputTokens: u.inputTokens,
    outputTokens: u.outputTokens,
    reasoningTokens: u.reasoningTokens,
    cachedTokens: u.cachedTokens,
    costUsd: u.costUsd,
  };
}

function outputScope(s: NonNullable<ReviewReport["scope"]>): Output<"scope"> {
  return s.mode === "incremental"
    ? { mode: s.mode, since: s.since }
    : { mode: s.mode, reason: s.reason };
}

function outputJudgement(j: JudgeDecisions): Output<"judgement"> {
  return {
    merged: j.merged.map((m) => ({ kept: m.kept, merged: [...m.merged] })),
    dropped: j.dropped.map((d) => ({
      fingerprint: d.fingerprint,
      file: d.file,
      title: d.title,
      reason: d.reason,
    })),
    recalibrated: j.recalibrated.map((r) => ({
      fingerprint: r.fingerprint,
      from: r.from,
      to: r.to,
      reason: r.reason,
    })),
  };
}

function outputAnchoring(a: AnchoringSummary): Output<"anchoring"> {
  return {
    byMethod: { ...a.byMethod },
    ambiguous: a.ambiguous,
    relocationCalls: a.relocationCalls,
  };
}

function outputSpendLimit(s: NonNullable<ReviewReport["spendLimit"]>): Output<"spendLimit"> {
  return s.reached === undefined ? { usd: s.usd } : { usd: s.usd, reached: s.reached };
}

function outputProvenance(p: RunProvenance): Output<"provenance"> {
  return {
    ocraVersion: p.ocraVersion,
    promptHash: p.promptHash,
    configHash: p.configHash,
    sampling: outputSampling(p.sampling),
    ...(p.agents
      ? {
          agents: Object.fromEntries(
            Object.entries(p.agents).map(([id, agent]) => [id, outputAgent(agent)]),
          ),
        }
      : {}),
    ...(p.rules
      ? {
          rules: p.rules.map((r) => ({
            path: [...r.path],
            rule: r.rule,
            ...(r.source ? { source: r.source } : {}),
          })),
        }
      : {}),
    ...(p.accountSettings ? { accountSettings: { version: p.accountSettings.version } } : {}),
  };
}

function outputSampling(s: AppliedSampling): Output<"provenance">["sampling"] {
  return {
    ...(s.temperature === undefined ? {} : { temperature: s.temperature }),
    ...(s.seed === undefined ? {} : { seed: s.seed }),
    ...(s.notApplied ? { notApplied: [...s.notApplied] } : {}),
  };
}

function outputAgent(a: AgentProvenance): NonNullable<Output<"provenance">["agents"]>[string] {
  return {
    tier: a.tier,
    ...(a.models ? { models: [...a.models] } : {}),
    ...(a.effort === undefined ? {} : { effort: a.effort }),
    ...(a.applied === undefined ? {} : { applied: a.applied }),
    ...(a.notApplied ? { notApplied: [...a.notApplied] } : {}),
  };
}

function outputPrior(f: PriorFinding): OutputPriorFinding {
  return {
    fingerprint: f.fingerprint,
    title: f.title,
    file: f.file,
    severity: f.severity,
    verification: f.verification ?? "unchecked",
    ...(f.reviewer ? { reviewer: f.reviewer } : {}),
  };
}
