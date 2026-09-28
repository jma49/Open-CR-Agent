import type { OutputFinding } from "@open-cr-agent/core";
import type { Instance } from "./dataset.js";
import type { ForbiddenRange } from "./golden.js";
import { matchComments, type SemanticJudge } from "./match.js";
import type { InstanceResult } from "./runner.js";
import { toGeneratedComment } from "./score.js";

// A finding as the maintainer sees it when labeling, and as failures list it.
export interface GoldenFinding {
  case: string;
  fingerprint: string;
  category: string;
  severity: OutputFinding["severity"];
  file: string;
  lines?: { start: number; end: number };
  title: string;
  body: string;
}

export interface GoldenSummary {
  counts: {
    expected: number;
    reported: number;
    matched: number;
    valid: number;
    invalid: number;
    forbidden: number;
    unadjudicated: number;
  };
  // (matched + adjudicated valid) / reported; unadjudicated findings count
  // against it until someone labels them, and are listed so they get labeled.
  precision: number;
  recall: number;
  failures: (GoldenFinding & { reason: string })[];
  unadjudicated: GoldenFinding[];
}

// ADR-0011: precision from recorded labels, never from a judge's guess, and
// a critical finding where a case says findings are wrong is a failure.
export async function scoreGolden(
  instances: readonly Instance[],
  results: readonly InstanceResult[],
  judge: SemanticJudge,
): Promise<GoldenSummary> {
  const byId = new Map(results.map((r) => [r.id, r]));
  const summary: GoldenSummary = {
    counts: {
      expected: 0,
      reported: 0,
      matched: 0,
      valid: 0,
      invalid: 0,
      forbidden: 0,
      unadjudicated: 0,
    },
    precision: 0,
    recall: 0,
    failures: [],
    unadjudicated: [],
  };
  const { counts } = summary;
  for (const instance of instances) {
    const result = byId.get(instance.id);
    if (!instance.golden || result?.status !== "reviewed") continue;
    const findings = result.findings;
    const matches = await matchComments(
      instance.references,
      findings.map(toGeneratedComment),
      judge,
    );
    const matched = new Set(matches.flatMap((m) => m.matchedIndex ?? []));
    const labels = new Map(instance.golden.adjudicated.map((a) => [a.fingerprint, a.label]));
    counts.expected += instance.references.length;
    counts.reported += findings.length;
    counts.matched += matched.size;
    for (const [index, finding] of findings.entries()) {
      if (matched.has(index)) continue;
      const golden = toGoldenFinding(instance.id, finding);
      const forbidden = instance.golden.forbid.find((f) => inRange(finding, f));
      if (finding.severity === "critical" && (instance.golden.clean || forbidden)) {
        summary.failures.push({
          ...golden,
          reason: forbidden?.reason ?? "the case has no issue",
        });
      }
      const label = labels.get(finding.fingerprint);
      if (label === "valid") counts.valid += 1;
      else if (label === "invalid") counts.invalid += 1;
      else if (forbidden) counts.forbidden += 1;
      else summary.unadjudicated.push(golden);
    }
  }
  counts.unadjudicated = summary.unadjudicated.length;
  summary.precision = ratio(counts.matched + counts.valid, counts.reported);
  summary.recall = ratio(counts.matched, counts.expected);
  return summary;
}

function toGoldenFinding(caseId: string, finding: OutputFinding): GoldenFinding {
  return {
    case: caseId,
    fingerprint: finding.fingerprint,
    category: finding.category,
    severity: finding.severity,
    file: finding.file,
    ...(finding.lines ? { lines: finding.lines } : {}),
    title: finding.title,
    body: finding.body,
  };
}

// A finding that could not be tied to lines is never inside a range.
function inRange(finding: OutputFinding, range: ForbiddenRange): boolean {
  if (finding.file !== range.path || !finding.lines) return false;
  return finding.lines.start <= range.toLine && range.fromLine <= finding.lines.end;
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}
