import type { OutputFinding, Severity } from "@open-cr-agent/core";
import { shortHash } from "@open-cr-agent/core/internal";
import { type ClaimStage, claimStages, countFunnel, type Funnel } from "./funnel.js";
import type { Adjudication, ForbiddenRange, Instance } from "./instance.js";
import { matchComments, type SemanticJudge } from "./match.js";
import type { InstanceResult } from "./results.js";
import { toGeneratedComment } from "./score.js";
import type { DropStage, MatchableFinding, SessionTrace } from "./session-trace.js";

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
    // Required claims only: an optional one (ADR-0036) is never expected.
    expected: number;
    reported: number;
    // Required claims that were found.
    matched: number;
    // Reported findings that match a claim, optional ones included (several
    // can, when an issue is reported at its location and at an alternate).
    correct: number;
    // Matched a required claim at a lower severity than it requires:
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
  // By case id, so runs that reviewed different cases can be compared on
  // the ones they share (trend.ts). Absent in summaries written before it.
  cases?: Record<string, GoldenCaseScore>;
  // The recall funnel over every required claim (funnel.ts). Absent in
  // summaries written before it.
  funnel?: Funnel;
}

export interface GoldenCaseScore {
  // Required claims.
  expected: number;
  // Required claims found at or above their severity: recall's numerator.
  found: number;
  reported: number;
  // Matched or labeled valid: precision's numerator.
  right: number;
  // Each expected finding, in the case's order, and whether it was found
  // at or above its severity; with the review's session log, how far it got.
  claims: GoldenClaimScore[];
}

export type GoldenClaimScore = {
  // The claim's id within its case (ADR-0036): runs pair claims by it.
  // Absent in summaries scored before claims had ids.
  id?: string;
  concern: string;
  found: boolean;
  // Counted for precision only: neither expected nor found counts it.
  optional?: true;
} & Partial<ClaimStage>;

// Scored before claims had ids: nothing pairs such a run's claims with
// another run's, so a claim-by-claim comparison must refuse it.
export function lacksClaimIds(cases: Record<string, GoldenCaseScore> | undefined): boolean {
  return Object.values(cases ?? {}).some((c) => c.claims.some((claim) => claim.id === undefined));
}

const RANK: Record<Severity, number> = { suggestion: 0, warning: 1, critical: 2 };

// ADR-0011: precision from recorded labels, never from a judge's guess, and
// a critical finding where a case says findings are wrong is a failure.
export async function scoreGolden(
  instances: readonly Instance[],
  results: readonly InstanceResult[],
  judge: SemanticJudge,
  traces: ReadonlyMap<string, SessionTrace> = new Map(),
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
  const cases: Record<string, GoldenCaseScore> = {};
  const { counts } = summary;
  for (const instance of instances) {
    const result = byId.get(instance.id);
    // An attack is compared with its clean case (attack-score.ts).
    if (!instance.golden || instance.golden.attack || result?.status !== "reviewed") continue;
    const findings = result.findings;
    const { matched, found } = await matchExpected(instance, findings, judge);
    const required = requiredClaims(instance);
    const requiredFound = required.filter((k) => found.has(k)).length;
    counts.expected += required.length;
    counts.reported += findings.length;
    counts.matched += requiredFound;
    counts.correct += matched.size;
    const atSeverity = foundAtSeverity(instance, found);
    counts.underrated += requiredFound - atSeverity;
    const trace = traces.get(instance.id);
    const stages = trace && (await funnelOf(instance, found, trace));
    const caseScore: GoldenCaseScore = {
      expected: required.length,
      found: atSeverity,
      reported: findings.length,
      right: matched.size,
      claims: instance.references.map((reference, k) => {
        const claim = instance.golden?.claims[k];
        return {
          ...(claim ? { id: claim.id } : {}),
          concern: reference.note,
          found: atRequiredSeverity(instance, k, found.get(k)),
          ...(claim?.optional ? { optional: true as const } : {}),
          ...stages?.[k],
        };
      }),
    };
    cases[instance.id] = caseScore;
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
      if (label === "valid") {
        counts.valid += 1;
        caseScore.right += 1;
      } else if (label === "invalid") counts.invalid += 1;
      else if (forbidden) counts.forbidden += 1;
      else summary.unadjudicated.push(golden);
    }
  }
  summary.cases = cases;
  summary.funnel = countFunnel(
    Object.values(cases).flatMap((c) => c.claims.filter((claim) => !claim.optional)),
  );
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

// Findings that never reached the report are matched by location alone
// (same file, lines within the matcher's tolerance), never by the judge:
// the funnel adds no model call to scoring. So raised and dropped say a task
// reported something at the expected lines, not that it was the same issue.
const AT_LOCATION: SemanticJudge = { sameIssue: async () => true };

async function funnelOf(
  instance: Instance,
  found: ReadonlyMap<number, OutputFinding>,
  trace: SessionTrace,
): Promise<ClaimStage[]> {
  const missed = new Set([...instance.references.keys()].filter((k) => !found.has(k)));
  const at = async <F extends MatchableFinding>(findings: readonly F[]) =>
    (await matchExpected(instance, findings, AT_LOCATION, missed)).found;
  const dropped = new Map<number, DropStage>();
  for (const [k, f] of await at(trace.raised.filter((f) => trace.removed.has(f.fingerprint)))) {
    const by = trace.removed.get(f.fingerprint);
    if (by) dropped.set(k, by);
  }
  for (const k of (await at(trace.outsideBundle)).keys()) {
    if (!dropped.has(k)) dropped.set(k, "outside_bundle");
  }
  const raised = await at(trace.raised.filter((f) => !trace.removed.has(f.fingerprint)));
  return claimStages(instance, trace, { found, dropped, raised });
}

export interface ExpectedMatch<F = OutputFinding> {
  // Indices of reported findings that match an expected one.
  matched: Set<number>;
  // Each expected finding that was found, by its index, with its most
  // severe report.
  found: Map<number, F>;
}

// An expected finding may be reported at its location or at an alternate:
// every variant is matched, and the finding is found once. `only` limits
// the expected findings looked for to those indices. A finding is used once,
// so required claims are matched first: an optional one never takes a
// finding a required one would have matched.
export async function matchExpected<F extends MatchableFinding>(
  instance: Instance,
  findings: readonly F[],
  judge: SemanticJudge,
  only?: ReadonlySet<number>,
): Promise<ExpectedMatch<F>> {
  const wanted = instance.references
    .flatMap((reference, k) => (only && !only.has(k) ? [] : [{ k, reference }]))
    .sort((a, b) => Number(isOptional(instance, a.k)) - Number(isOptional(instance, b.k)));
  const variants = wanted.flatMap(({ k, reference }) => [
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
  const found = new Map<number, F>();
  for (const [i, match] of matches.entries()) {
    const finding = match.matchedIndex === undefined ? undefined : findings[match.matchedIndex];
    const k = variants[i]?.k;
    if (!finding || k === undefined) continue;
    const earlier = found.get(k);
    if (!earlier || RANK[finding.severity] > RANK[earlier.severity]) found.set(k, finding);
  }
  return { matched, found };
}

// ADR-0036: an optional claim is real but not required of a review.
function isOptional(instance: Instance, k: number): boolean {
  return instance.golden?.claims[k]?.optional === true;
}

// Indices of the claims recall counts.
function requiredClaims(instance: Instance): number[] {
  return [...instance.references.keys()].filter((k) => !isOptional(instance, k));
}

// Claims found at or above the severity their case asks for: the required
// ones for recall, every one for an attack, which asks only whether planted
// text hid a finding the clean case's review reported.
export function foundAtSeverity(
  instance: Instance,
  found: ReadonlyMap<number, OutputFinding>,
  claims: "required" | "all" = "required",
): number {
  let count = 0;
  for (const [k, finding] of found) {
    if (claims === "required" && isOptional(instance, k)) continue;
    if (atRequiredSeverity(instance, k, finding)) count += 1;
  }
  return count;
}

function atRequiredSeverity(instance: Instance, k: number, finding?: OutputFinding): boolean {
  const required = instance.golden?.minSeverity[k] ?? "suggestion";
  return finding !== undefined && RANK[finding.severity] >= RANK[required];
}

// Claims are hashed in id order, so reordering a case's claims changes
// nothing that runs compare: they pair claims by id.
function casesHash(instances: readonly Instance[]): string {
  const cases = instances
    .flatMap((i) => (i.golden ? [{ ...i, golden: i.golden }] : []))
    .map(({ id, baseCommit, headCommit, references, golden }) => {
      const { claims, minSeverity, alternates, ...rest } = golden;
      const byId = references
        .map((reference, k) => ({
          ...claims[k],
          reference,
          minSeverity: minSeverity[k],
          also: alternates[k],
        }))
        .sort((a, b) => (a.id ?? "").localeCompare(b.id ?? ""));
      return { id, base: baseCommit, head: headCommit, claims: byId, golden: rest };
    })
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
