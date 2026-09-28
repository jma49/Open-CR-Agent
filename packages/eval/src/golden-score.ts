import { createHash } from "node:crypto";
import type { OutputFinding, Severity } from "@open-cr-agent/core";
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
    // Expected findings that were found.
    matched: number;
    // Reported findings that match an expected one (several can, when an
    // issue is reported at its location and at an alternate).
    correct: number;
    // Matched an expected finding at a lower severity than it requires:
    // correct for precision, a miss for recall.
    underrated: number;
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
  // A label applies by fingerprint (category, file, quoted code); a later
  // finding on the same code may claim something else. Listed for a look.
  relabeled: (GoldenFinding & { labeledTitle: string })[];
  // Runs scored against different case files are not comparable.
  casesHash: string;
}

const RANK: Record<Severity, number> = { suggestion: 0, warning: 1, critical: 2 };

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
      correct: 0,
      underrated: 0,
      valid: 0,
      invalid: 0,
      forbidden: 0,
      unadjudicated: 0,
    },
    precision: 0,
    recall: 0,
    failures: [],
    unadjudicated: [],
    relabeled: [],
    casesHash: casesHash(instances),
  };
  const { counts } = summary;
  for (const instance of instances) {
    const result = byId.get(instance.id);
    if (!instance.golden || result?.status !== "reviewed") continue;
    const findings = result.findings;
    // An expected finding may be reported at its location or at an
    // alternate: every variant is matched, and the finding is found once.
    const variants = instance.references.flatMap((reference, k) => [
      { k, reference },
      ...(instance.golden?.alternates[k] ?? []).map((a) => ({
        k,
        reference: { ...reference, path: a.path, fromLine: a.fromLine, toLine: a.toLine },
      })),
    ]);
    const matches = await matchComments(
      variants.map((v) => v.reference),
      findings.map(toGeneratedComment),
      judge,
    );
    const matched = new Set(matches.flatMap((m) => m.matchedIndex ?? []));
    const found = new Map<number, OutputFinding>();
    for (const [i, match] of matches.entries()) {
      const finding = match.matchedIndex === undefined ? undefined : findings[match.matchedIndex];
      const k = variants[i]?.k;
      if (!finding || k === undefined) continue;
      const earlier = found.get(k);
      if (!earlier || RANK[finding.severity] > RANK[earlier.severity]) found.set(k, finding);
    }
    const labels = new Map(instance.golden.adjudicated.map((a) => [a.fingerprint, a]));
    counts.expected += instance.references.length;
    counts.reported += findings.length;
    counts.matched += found.size;
    counts.correct += matched.size;
    for (const [k, finding] of found) {
      const required = instance.golden.minSeverity[k] ?? "suggestion";
      if (RANK[finding.severity] < RANK[required]) counts.underrated += 1;
    }
    for (const [index, finding] of findings.entries()) {
      if (matched.has(index)) continue;
      const golden = toGoldenFinding(instance.id, finding);
      const forbidden = instance.golden.forbid.find((f) => inRange(finding, f));
      const adjudicated = labels.get(finding.fingerprint);
      const label = adjudicated?.label;
      if (adjudicated && adjudicated.title !== finding.title) {
        summary.relabeled.push({ ...golden, labeledTitle: adjudicated.title });
      }
      // The maintainer judged it real: not a failure, whatever the case says.
      if (
        finding.severity === "critical" &&
        label !== "valid" &&
        (instance.golden.clean || forbidden)
      ) {
        summary.failures.push({
          ...golden,
          reason: forbidden?.reason ?? "the case has no issue",
        });
      }
      if (label === "valid") counts.valid += 1;
      else if (label === "invalid") counts.invalid += 1;
      else if (forbidden) counts.forbidden += 1;
      else summary.unadjudicated.push(golden);
    }
  }
  counts.unadjudicated = summary.unadjudicated.length;
  summary.precision = ratio(counts.correct + counts.valid, counts.reported);
  summary.recall = ratio(counts.matched - counts.underrated, counts.expected);
  return summary;
}

function casesHash(instances: readonly Instance[]): string {
  const cases = instances
    .filter((i) => i.golden)
    .map((i) => ({
      id: i.id,
      base: i.baseCommit,
      head: i.headCommit,
      references: i.references,
      golden: i.golden,
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
  return createHash("sha256").update(JSON.stringify(cases)).digest("hex").slice(0, 16);
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
