import type { Severity } from "@open-cr-agent/core";
import { errorMessage } from "@open-cr-agent/core";
import { isOutOfScope, type ReferenceReach } from "./ceiling.js";
import { type DatasetRecord, prInstance, toReference } from "./dataset.js";
import {
  type GoldenCase,
  MAX_OPTIONAL_CLAIMS,
  MAX_REQUIRED_CLAIMS,
  parseCandidate,
  REFERENCE_CATEGORY,
} from "./golden.js";
import type { Instance } from "./instance.js";
import type { LicenceVerdict } from "./licence.js";
import { shuffle } from "./select.js";

// Golden case candidates from AACR-Bench, chosen and written without a model.
// An AACR-Bench reference is a review comment, most often written by a model
// (is_ai_comment), not a confirmed bug, so every case says it is unverified
// until someone checks it against the code, and its licence too (ADR-0036).

// The --max-change-lines the evaluation manual uses for a run: small enough
// for one review per pull request.
export const DEFAULT_MAX_CHANGE_LINES = 300;
// AACR-Bench has no severity; the lowest makes a match at any severity count
// for recall until someone raises it.
const DEFAULT_SEVERITY: Severity = "suggestion";
const MAX_CONCERN_CHARS = 500;

type GoldenCategory = keyof typeof REFERENCE_CATEGORY;
const GOLDEN_CATEGORY = new Map<string, GoldenCategory>(
  Object.entries(REFERENCE_CATEGORY).map(([golden, aacr]) => [aacr, golden as GoldenCategory]),
);

// A row of the dataset with its index, which is how a case names the
// comments it restates.
interface AacrIssue {
  row: number;
  record: DatasetRecord;
}

// An in-scope comment of the pull request that its case does not restate,
// and why; the case's rationale lists them.
interface LeftOut {
  row: number;
  path: string;
  reason: string;
}

export interface ImportCandidate {
  // References are the issues, in their order, so a classification of the
  // instance lines up with them.
  instance: Instance;
  issues: AacrIssue[];
  leftOut: LeftOut[];
  // The pull request's comments AACR-Bench labels incorrect (label 0): seeds
  // for forbid ranges, never claims (ADR-0036 point 1).
  incorrect: AacrIssue[];
}

export interface CandidateOptions {
  maxChangeLines: number;
  // Head commits already in the golden set.
  exclude: ReadonlySet<string>;
}

function inScope(record: DatasetRecord): boolean {
  return (
    record.label === 1 && !isOutOfScope(record.category) && GOLDEN_CATEGORY.has(record.category)
  );
}

// A row without is_ai_comment is not taken for a person's.
function isHuman(record: DatasetRecord): boolean {
  return record.is_ai_comment === false;
}

function lineRange(record: DatasetRecord): [number, number] | null {
  const from = record.from_line;
  if (from === null || !Number.isInteger(from) || from < 1) return null;
  return [from, Math.max(from, record.to_line ?? from)];
}

// Golden expectations sit on the new side, so a comment on removed lines, or
// one without lines, is left out of its case. A person's comment becomes a
// required claim, so a pull request with more of them than a case may
// require is skipped; models' comments become optional claims.
export function importCandidates(
  records: readonly DatasetRecord[],
  options: CandidateOptions,
): ImportCandidate[] {
  const byPr = new Map<
    string,
    { first: DatasetRecord; inScope: AacrIssue[]; incorrect: AacrIssue[] }
  >();
  for (const [row, record] of records.entries()) {
    const pr = byPr.get(record.pr_url) ?? { first: record, inScope: [], incorrect: [] };
    if (inScope(record)) pr.inScope.push({ row, record });
    else if (record.label === 0) pr.incorrect.push({ row, record });
    byPr.set(record.pr_url, pr);
  }
  const candidates: ImportCandidate[] = [];
  for (const { first, inScope: all, incorrect } of byPr.values()) {
    if (first.pr_change_line_count > options.maxChangeLines) continue;
    if (options.exclude.has(first.pr_target_commit)) continue;
    const placed = (i: AacrIssue) => i.record.side === "right" && lineRange(i.record) !== null;
    const issues = all.filter(placed);
    if (issues.length === 0) continue;
    if (issues.filter((i) => isHuman(i.record)).length > MAX_REQUIRED_CLAIMS) continue;
    const instance = prInstance(first);
    instance.references = issues.map((i) => toReference(i.record));
    const leftOut = all
      .filter((i) => !placed(i))
      .map((i) => ({
        row: i.row,
        path: i.record.path,
        reason: i.record.side === "right" ? "without lines" : "on removed lines",
      }));
    candidates.push({ instance, issues, leftOut, incorrect });
  }
  return candidates.sort((a, b) => a.instance.id.localeCompare(b.instance.id));
}

function hasHumanIssue(candidate: ImportCandidate): boolean {
  return candidate.issues.some((i) => isHuman(i.record));
}

// People's comments first (ADR-0036 point 1): pull requests with at least one
// come before those only models commented on.
export function humanFirst(
  candidates: readonly ImportCandidate[],
): [ImportCandidate[], ImportCandidate[]] {
  return [candidates.filter(hasHumanIssue), candidates.filter((c) => !hasHumanIssue(c))];
}

// Seeded per language, then one language at a time in turn, so a limit
// spreads the cases across languages instead of taking the largest first.
export function byLanguage(
  candidates: readonly ImportCandidate[],
  seed: number,
): ImportCandidate[][] {
  const groups = new Map<string, ImportCandidate[]>();
  for (const c of candidates) {
    const group = groups.get(c.instance.language) ?? [];
    group.push(c);
    groups.set(c.instance.language, group);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, group]) => shuffle(group, seed));
}

// A comment AACR-Bench labels incorrect on an imported pull request, for a
// vetter to turn into a forbid range or discard.
interface ForbidSeed {
  case: string;
  row: number;
  file: string;
  side: "left" | "right";
  lines: [number, number] | null;
  category: string;
  isAiComment: boolean;
  producer: string;
  note: string;
}

export interface Imported {
  case: GoldenCase;
  forbidSeeds: ForbidSeed[];
  leftOut: LeftOut[];
}

export type Verdict = Imported | { rejected: string };

// Each round takes the next acceptable candidate of every language, until
// the limit is reached or every language is spent.
export async function pickInTurn(
  queues: readonly ImportCandidate[][],
  limit: number,
  judge: (candidate: ImportCandidate) => Promise<Verdict>,
  log: (message: string) => void,
): Promise<Imported[]> {
  const pending = queues.map((q) => [...q]);
  const picked: Imported[] = [];
  while (picked.length < limit && pending.some((q) => q.length > 0)) {
    for (const queue of pending) {
      if (picked.length >= limit) break;
      let candidate = queue.shift();
      while (candidate) {
        const verdict = await judge(candidate);
        if ("case" in verdict) {
          picked.push(verdict);
          log(`${candidate.instance.id}: imported as ${verdict.case.id}`);
          break;
        }
        log(`${candidate.instance.id}: skipped, ${verdict.rejected}`);
        candidate = queue.shift();
      }
    }
  }
  return picked;
}

// What git says about a candidate: the merge base its case records, the
// head commit's date, and the licence its root files state at head.
export interface CandidateFacts {
  base: string;
  date: string;
  licence: LicenceVerdict;
}

// Each in-scope comment counts on its own: one ocra's deterministic stages
// cannot reach, as the recall ceiling decides it, is left out with its
// reason, and a pull request is skipped only when none is reachable.
// Models' comments past the cap on optional claims are left out in row order.
export function verdictFor(
  candidate: ImportCandidate,
  reaches: readonly ReferenceReach[],
  facts: CandidateFacts,
): Verdict {
  const leftOut = [...candidate.leftOut];
  const reached: AacrIssue[] = [];
  for (const [k, issue] of candidate.issues.entries()) {
    const reach = reaches[k];
    if (reach?.reach === "reachable") reached.push(issue);
    else {
      const why = reach
        ? `${reach.reach}${reach.detail ? `: ${reach.detail}` : ""}`
        : "unclassified";
      leftOut.push({ row: issue.row, path: issue.record.path, reason: why });
    }
  }
  if (reached.length === 0) {
    return {
      rejected: `not reachable: ${leftOut.map((l) => `${l.path} (${l.reason})`).join(", ")}`,
    };
  }
  const overCap = new Set(reached.filter((i) => !isHuman(i.record)).slice(MAX_OPTIONAL_CLAIMS));
  for (const issue of overCap) {
    const reason = `past the cap of ${MAX_OPTIONAL_CLAIMS} optional claims`;
    leftOut.push({ row: issue.row, path: issue.record.path, reason });
  }
  const kept = { ...candidate, issues: reached.filter((i) => !overCap.has(i)), leftOut };
  try {
    const golden = toGoldenCase(kept, facts);
    return { case: golden, forbidSeeds: forbidSeeds(candidate, golden.id), leftOut };
  } catch (error) {
    return { rejected: errorMessage(error) };
  }
}

export function toGoldenCase(candidate: ImportCandidate, facts: CandidateFacts): GoldenCase {
  const { instance, issues } = candidate;
  const rows = issues.map((i) => i.row).join(", ");
  const name = instance.repo.split("/")[1] ?? instance.repo;
  const data = {
    id: `aacr-${slug(name)}-${instance.headCommit.slice(0, 7)}`,
    repo: instance.repo,
    base: facts.base,
    head: instance.headCommit,
    language: instance.language,
    tier: "full",
    source: {
      kind: "aacr",
      ref: `${instance.prUrl}; AACR-Bench dataset.json rows ${rows}; ${facts.licence.note}; imported by ocra-eval golden-import, not hand-checked`,
      licence: facts.licence.licence,
      date: facts.date,
    },
    rationale: rationale(candidate),
    expect: issues.map(({ row, record }) => ({
      id: `row-${row}`,
      file: record.path,
      lines: lineRange(record),
      category: GOLDEN_CATEGORY.get(record.category),
      minSeverity: DEFAULT_SEVERITY,
      concern: excerpt(record.note),
      ...provenance(record),
    })),
  };
  return parseCandidate(data, data.id);
}

function rationale({ issues, leftOut, incorrect }: ImportCandidate): string {
  const human = issues.filter((i) => isHuman(i.record)).length;
  const left = [...leftOut].sort((a, b) => a.row - b.row);
  return [
    `Unverified import: ${issues.length} in-scope review comment(s) from AACR-Bench on changed lines, ${human} of them written by people and the rest by models.`,
    "They are comments, not confirmed bugs; check each expectation against the code at head, set minSeverity, add forbid ranges and confirm the licence before relying on this case.",
    ...(human === 0
      ? ["Every claim restates a model's comment: vet this case after those with people's."]
      : []),
    ...(incorrect.length > 0
      ? [
          `forbid-seeds.json lists ${incorrect.length} comment(s) on this pull request that AACR-Bench labels incorrect.`,
        ]
      : []),
    ...(left.length > 0
      ? [`Left out: ${left.map((l) => `row ${l.row} (${l.path}, ${l.reason})`).join("; ")}.`]
      : []),
  ].join(" ");
}

// A comment a model wrote is optional until vetting promotes it (ADR-0036
// point 5).
function provenance(record: DatasetRecord): {
  origin: string;
  producer: string;
  optional: boolean;
} {
  return isHuman(record)
    ? { origin: "human-review", producer: "human", optional: false }
    : { origin: "ai-reference-vetted", producer: producer(record), optional: true };
}

function producer(record: DatasetRecord): string {
  return isHuman(record) ? "human" : record.source_model || "unknown model";
}

function forbidSeeds(candidate: ImportCandidate, caseId: string): ForbidSeed[] {
  return candidate.incorrect.map(({ row, record }) => ({
    case: caseId,
    row,
    file: record.path,
    side: record.side,
    lines: lineRange(record),
    category: record.category,
    isAiComment: !isHuman(record),
    producer: producer(record),
    note: excerpt(record.note),
  }));
}

export function renderForbidSeeds(imported: readonly Imported[]): string {
  const seeds = imported
    .flatMap((i) => i.forbidSeeds)
    .sort((a, b) => (a.case === b.case ? a.row - b.row : a.case < b.case ? -1 : 1));
  const about =
    "AACR-Bench comments labelled incorrect (label 0) on the imported pull requests: seeds for forbid ranges, to vet like any claim (ADR-0036). No case includes them.";
  return `${JSON.stringify({ about, seeds }, null, 2)}\n`;
}

function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function excerpt(note: string): string {
  const flat = note.replace(/\s+/g, " ").trim();
  if (flat.length <= MAX_CONCERN_CHARS) return flat;
  const cut = flat.slice(0, MAX_CONCERN_CHARS);
  return `${cut.slice(0, cut.lastIndexOf(" ") > 0 ? cut.lastIndexOf(" ") : cut.length)} …`;
}
