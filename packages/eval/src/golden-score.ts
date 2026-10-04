import type { OutputFinding, Severity } from "@open-cr-agent/core";
import { shortHash } from "@open-cr-agent/core/internal";
import type { Adjudication, ForbiddenRange, Instance } from "./instance.js";
import { matchComments, type SemanticJudge } from "./match.js";
import type { InstanceResult } from "./results.js";
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
  // Findings that took a label recorded for another title, because the
  // judge called it the same claim (labelFor). Listed for a look.
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
    // An attack is compared with its clean case (attack-score.ts).
    if (!instance.golden || instance.golden.attack || result?.status !== "reviewed") continue;
    const findings = result.findings;
    const { matched, found } = await matchExpected(instance, findings, judge);
    counts.expected += instance.references.length;
    counts.reported += findings.length;
    counts.matched += found.size;
    counts.correct += matched.size;
    counts.underrated += found.size - foundAtSeverity(instance, found);
    for (const [index, finding] of findings.entries()) {
      if (matched.has(index)) continue;
      const golden = toGoldenFinding(instance.id, finding);
      const forbidden = instance.golden.forbid.find((f) => inRange(finding, f));
      const adjudicated = await labelFor(finding, instance.golden.adjudicated, judge);
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

// Labels are keyed by the quoted code, and code that drew one claim can draw
// another: a valid label must not make a wrong claim on the same lines count
// as correct (#235). A label applies to its own claim only, matched by title
// or, when the wording changed, by the judge.
async function labelFor(
  finding: OutputFinding,
  labels: readonly Adjudication[],
  judge: SemanticJudge,
): Promise<Adjudication | undefined> {
  const onSameCode = labels.filter((l) => l.fingerprint === finding.fingerprint);
  const sameTitle = onSameCode.find((l) => l.title === finding.title);
  if (sameTitle) return sameTitle;
  const claim = toGeneratedComment(finding).note;
  for (const label of onSameCode) {
    if (await judge.sameIssue(label.title, claim)) return label;
  }
  return undefined;
}

export interface ExpectedMatch {
  // Indices of reported findings that match an expected one.
  matched: Set<number>;
  // Each expected finding that was found, by its index, with its most
  // severe report.
  found: Map<number, OutputFinding>;
}

// An expected finding may be reported at its location or at an alternate:
// every variant is matched, and the finding is found once.
export async function matchExpected(
  instance: Instance,
  findings: readonly OutputFinding[],
  judge: SemanticJudge,
): Promise<ExpectedMatch> {
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
  return { matched, found };
}

// Expected findings found at or above the severity their case asks for.
export function foundAtSeverity(
  instance: Instance,
  found: ReadonlyMap<number, OutputFinding>,
): number {
  let count = 0;
  for (const [k, finding] of found) {
    const required = instance.golden?.minSeverity[k] ?? "suggestion";
    if (RANK[finding.severity] >= RANK[required]) count += 1;
  }
  return count;
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
  return shortHash(JSON.stringify(cases));
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
