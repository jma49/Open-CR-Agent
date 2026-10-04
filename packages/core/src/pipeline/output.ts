import type { Usage } from "../contracts.js";
import type {
  ChangeRequest,
  Finding,
  PriorFinding,
  RiskTier,
  Severity,
  Verdict,
  Verification,
} from "../domain.js";
import type { JudgeDecisions } from "../judge/judge.js";
import type { MemoryEntry } from "../memory/memory.js";
import type { RefutedFinding } from "../verify/verify.js";
import type { SkippedCell } from "./matrix.js";
import type { ReviewPreview } from "./preview.js";
import type { RunProvenance } from "./provenance.js";
import type { AnchoringSummary, CoverageEntry, ReviewReport, TaskOutcome } from "./report.js";

// The published shape of a review: `--format json` and a session's
// report.json. It is a contract with scripts and CI, so it carries a version
// and only what a reader can rely on; internal fields (per-run ids, how each
// finding was anchored, code signatures, platform state) stay out, though the
// anchoring counts of the whole run are in. Change it
// only by adding optional fields, or by a new version.
export const REPORT_VERSION = 1;

export interface OutputFinding {
  // Stable across runs for the same issue; `ocra memory add` takes a prefix.
  fingerprint: string;
  reviewer: string;
  category: string;
  severity: Severity;
  verification: Verification;
  file: string;
  // Absent when the finding could not be tied to lines.
  lines?: { start: number; end: number };
  // Whether the lines are inside the change (inline comments need that).
  inDiff: boolean;
  // "unfixed": an earlier review reported it too.
  status: "new" | "unfixed";
  title: string;
  body: string;
  suggestion?: string;
  evidence: string[];
  // The code the reviewer quoted.
  code: string;
  // --ultra: shown, not counted in the verdict.
  lowConfidence?: true;
  // Added in version 1 without a bump: the task in `tasks` that reported
  // the finding and, when the runtime said, the model.
  provenance?: { task: string; model?: string };
}

export interface OutputPriorFinding {
  fingerprint: string;
  title: string;
  file: string;
  severity: Severity;
  verification: Verification;
}

export interface ReportOutput {
  version: typeof REPORT_VERSION;
  // Added in version 1 without a bump: the run id, the session directory's
  // name, also in the progress output, the summary comment and the SARIF log.
  runId?: string;
  changeRequest: ChangeRequest;
  tier: RiskTier;
  verdict: Verdict;
  summary: string;
  scope?: ReviewReport["scope"];
  coverage: CoverageEntry[];
  findings: OutputFinding[];
  unverifiedCriticals: number;
  refuted: RefutedFinding[];
  remembered: MemoryEntry[];
  judgement?: JudgeDecisions;
  rereview?: Record<
    "fixed" | "notReproduced" | "notRechecked" | "unchanged" | "dismissed",
    OutputPriorFinding[]
  >;
  tasks: TaskOutcome[];
  skipped: SkippedCell[];
  bundles: { label: string; files: string[] }[];
  // Added in version 1 without a bump: optional, so older readers ignore it.
  anchoring?: AnchoringSummary;
  // Added in version 1 without a bump, like `anchoring`.
  spendLimit?: ReviewReport["spendLimit"];
  // Added in version 1 without a bump: the ocra version, the hashes of the
  // system prompts and of the configuration, and the sampling applied.
  provenance?: RunProvenance;
  usage: Usage;
  warnings: string[];
}

export function toReportOutput(report: ReviewReport): ReportOutput {
  const output: ReportOutput = {
    version: REPORT_VERSION,
    runId: report.runId,
    changeRequest: report.changeRequest,
    tier: report.tier,
    verdict: report.verdict,
    summary: report.summary,
    coverage: report.coverage,
    findings: report.findings.map(outputFinding),
    unverifiedCriticals: report.unverifiedCriticals,
    refuted: report.refuted,
    remembered: report.remembered,
    tasks: report.tasks,
    skipped: report.skipped,
    bundles: report.bundles,
    usage: report.usage,
    warnings: report.warnings,
  };
  if (report.scope) output.scope = report.scope;
  if (report.judgement) output.judgement = report.judgement;
  if (report.anchoring) output.anchoring = report.anchoring;
  if (report.spendLimit) output.spendLimit = report.spendLimit;
  if (report.provenance) output.provenance = report.provenance;
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
  if (f.lowConfidence) output.lowConfidence = true;
  output.provenance =
    f.provenance.model === undefined
      ? { task: f.provenance.task }
      : { task: f.provenance.task, model: f.provenance.model };
  return output;
}

function outputPrior(f: PriorFinding): OutputPriorFinding {
  return {
    fingerprint: f.fingerprint,
    title: f.title,
    file: f.file,
    severity: f.severity,
    verification: f.verification ?? "unchecked",
  };
}

// The published shape of `ocra review --plan --format json`, versioned like
// the report. The preview is already free of internal fields; the version
// makes the contract explicit.
export const PLAN_VERSION = 1;

export type PlanOutput = { version: typeof PLAN_VERSION } & ReviewPreview;

export function toPlanOutput(preview: ReviewPreview): PlanOutput {
  return {
    version: PLAN_VERSION,
    changeRequest: preview.changeRequest,
    tier: preview.tier,
    selected: preview.selected,
    excluded: preview.excluded,
    bundles: preview.bundles,
    groupingSkipped: preview.groupingSkipped,
    tasks: preview.tasks,
    skipped: preview.skipped,
    promptTokens: preview.promptTokens,
    // Added in version 1 without a bump: a new field older readers ignore.
    planCalls: preview.planCalls,
    warnings: preview.warnings,
  };
}

// Characters a terminal or an editor acts on: C0 controls but tab and
// newline, DEL and C1 controls (ANSI and OSC escapes), line and paragraph
// separators, and bidirectional marks and overrides ("Trojan Source"). One
// definition for every output: terminal text replaces them, JSON escapes them.
export function isUnsafeCodePoint(code: number): boolean {
  return (
    (code <= 0x1f && code !== 0x09 && code !== 0x0a) ||
    (code >= 0x7f && code <= 0x9f) ||
    code === 0x061c ||
    code === 0x200e ||
    code === 0x200f ||
    code === 0x2028 ||
    code === 0x2029 ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2066 && code <= 0x2069)
  );
}

// JSON for files and stdout. JSON.stringify escapes C0 controls but not the
// rest; model and pull request text reaches these files.
export function serializeOutput(value: unknown, indent = 2): string {
  let out = "";
  for (const char of JSON.stringify(value, null, indent)) {
    const code = char.codePointAt(0) ?? 0;
    out +=
      code > 0x1f && isUnsafeCodePoint(code) ? `\\u${code.toString(16).padStart(4, "0")}` : char;
  }
  return out;
}
