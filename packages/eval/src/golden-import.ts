import type { Severity } from "@open-cr-agent/core";
import { errorMessage } from "@open-cr-agent/core";
import { isOutOfScope, type ReferenceReach } from "./ceiling.js";
import { type DatasetRecord, prInstance, toReference } from "./dataset.js";
import { type GoldenCase, parseCase, REFERENCE_CATEGORY } from "./golden.js";
import type { Instance } from "./instance.js";
import { shuffle } from "./select.js";

// Golden case candidates from AACR-Bench, chosen and written without a model.
// An AACR-Bench reference is a human review comment, not a confirmed bug, so
// every case says it is unverified until someone checks it against the code.

// The --max-change-lines the evaluation manual uses for a run: small enough
// for one review per pull request.
export const DEFAULT_MAX_CHANGE_LINES = 300;
const MAX_ISSUES = 3;
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

export interface ImportCandidate {
  // References are the issues, in their order, so a classification of the
  // instance lines up with them.
  instance: Instance;
  issues: AacrIssue[];
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

// Golden expectations sit on the new side, so a pull request whose in-scope
// comments include one on removed lines, or one without lines, is skipped
// rather than imported with an issue missing.
export function importCandidates(
  records: readonly DatasetRecord[],
  options: CandidateOptions,
): ImportCandidate[] {
  const byPr = new Map<string, AacrIssue[]>();
  const firstRow = new Map<string, DatasetRecord>();
  for (const [row, record] of records.entries()) {
    if (!firstRow.has(record.pr_url)) firstRow.set(record.pr_url, record);
    if (!inScope(record)) continue;
    const issues = byPr.get(record.pr_url) ?? [];
    issues.push({ row, record });
    byPr.set(record.pr_url, issues);
  }
  const candidates: ImportCandidate[] = [];
  for (const [url, issues] of byPr) {
    const first = firstRow.get(url);
    if (!first) continue;
    if (issues.length > MAX_ISSUES) continue;
    if (first.pr_change_line_count > options.maxChangeLines) continue;
    if (options.exclude.has(first.pr_target_commit)) continue;
    if (issues.some((i) => i.record.side !== "right" || i.record.from_line === null)) continue;
    const instance = prInstance(first);
    instance.references = issues.map((i) => toReference(i.record));
    candidates.push({ instance, issues });
  }
  return candidates.sort((a, b) => a.instance.id.localeCompare(b.instance.id));
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

export type Verdict = { case: GoldenCase } | { rejected: string };

// Each round takes the next acceptable candidate of every language, until
// the limit is reached or every language is spent.
export async function pickInTurn(
  queues: readonly ImportCandidate[][],
  limit: number,
  judge: (candidate: ImportCandidate) => Promise<Verdict>,
  log: (message: string) => void,
): Promise<GoldenCase[]> {
  const pending = queues.map((q) => [...q]);
  const picked: GoldenCase[] = [];
  while (picked.length < limit && pending.some((q) => q.length > 0)) {
    for (const queue of pending) {
      if (picked.length >= limit) break;
      let candidate = queue.shift();
      while (candidate) {
        const verdict = await judge(candidate);
        if ("case" in verdict) {
          picked.push(verdict.case);
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

// Accepted only when every in-scope issue is one ocra's deterministic stages
// can reach, as the recall ceiling decides it.
export function verdictFor(
  candidate: ImportCandidate,
  reaches: readonly ReferenceReach[],
  base: string,
): Verdict {
  const blocked = reaches.filter((r) => r.reach !== "reachable");
  if (blocked.length > 0) {
    return {
      rejected: `not reachable: ${blocked.map((r) => `${r.path} (${r.reach})`).join(", ")}`,
    };
  }
  try {
    return { case: toGoldenCase(candidate, base) };
  } catch (error) {
    return { rejected: errorMessage(error) };
  }
}

export function toGoldenCase(candidate: ImportCandidate, base: string): GoldenCase {
  const { instance, issues } = candidate;
  const rows = issues.map((i) => i.row).join(", ");
  const name = instance.repo.split("/")[1] ?? instance.repo;
  const data = {
    id: `aacr-${slug(name)}-${instance.headCommit.slice(0, 7)}`,
    repo: instance.repo,
    base,
    head: instance.headCommit,
    language: instance.language,
    tier: "full",
    source: {
      kind: "aacr",
      ref: `${instance.prUrl}; AACR-Bench dataset.json rows ${rows}; imported by ocra-eval golden-import, not hand-checked; licence not checked`,
    },
    rationale: `Unverified import: ${issues.length} in-scope human review comment(s) from AACR-Bench on changed lines. They are reviewers' comments, not confirmed bugs; check each expectation against the code at head, set minSeverity, and add forbid ranges before relying on this case.`,
    expect: issues.map(({ record }) => ({
      file: record.path,
      lines: [record.from_line, Math.max(record.from_line ?? 0, record.to_line ?? 0)],
      category: GOLDEN_CATEGORY.get(record.category),
      minSeverity: DEFAULT_SEVERITY,
      concern: concern(record.note),
    })),
  };
  return parseCase(data, data.id);
}

function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function concern(note: string): string {
  const flat = note.replace(/\s+/g, " ").trim();
  if (flat.length <= MAX_CONCERN_CHARS) return flat;
  const cut = flat.slice(0, MAX_CONCERN_CHARS);
  return `${cut.slice(0, cut.lastIndexOf(" ") > 0 ? cut.lastIndexOf(" ") : cut.length)} …`;
}

// What a reviewer of the candidates needs to see first: how they spread.
export function renderImportSummary(cases: readonly GoldenCase[], outDir: string): string {
  const count = (keys: string[]) => {
    const totals = new Map<string, number>();
    for (const k of keys) totals.set(k, (totals.get(k) ?? 0) + 1);
    return [...totals.entries()].sort(([a], [b]) => a.localeCompare(b));
  };
  const expects = cases.flatMap((c) => c.expect);
  const table = (title: string, rows: [string, number][]) => [
    `| ${title} | Count |`,
    "|---|---|",
    ...rows.map(([k, n]) => `| ${k} | ${n} |`),
    "",
  ];
  return [
    "# AACR-Bench golden candidates",
    "",
    `${cases.length} case(s) with ${expects.length} expected finding(s), written to ${outDir}. Unverified: each expectation restates a human review comment; check it before moving the case to evals/golden.`,
    "",
    ...table("Language (cases)", count(cases.map((c) => c.language))),
    ...table("Category (expected findings)", count(expects.map((e) => e.category))),
    ...table("minSeverity (defaulted)", count(expects.map((e) => e.minSeverity))),
  ].join("\n");
}
