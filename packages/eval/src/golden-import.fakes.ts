import type { ReferenceReach } from "./ceiling.js";
import { type DatasetRecord, parseRecords } from "./dataset.js";
import { type CandidateFacts, type ImportCandidate, importCandidates } from "./golden-import.js";

// An AACR-Bench row: a person's in-scope comment on PR `pr` of acme/api,
// whose head commit starts with the PR number.
export function record(pr: number, overrides: Record<string, unknown> = {}) {
  return {
    project_main_language: "Go",
    pr_url: `https://github.com/acme/api/pull/${pr}`,
    pr_source_commit: "a".repeat(40),
    pr_target_commit: `${String(pr).padStart(7, "0")}${"b".repeat(33)}`,
    pr_change_line_count: 120,
    pr_category: "Bug Fix",
    is_ai_comment: false,
    note: "nil map write\n\n  panics when the cache is cold",
    path: "server/handler.go",
    side: "right",
    source_model: "",
    from_line: 10,
    to_line: 12,
    category: "Code Defect",
    context: "File Level",
    label: 1,
    ...overrides,
  };
}

export const model = (name = "GLM-4.7") => ({ is_ai_comment: true, source_model: name });

// One pull request per selection rule, plus the ones that pass.
export const fixture: DatasetRecord[] = parseRecords([
  record(1),
  record(1, { category: "Maintainability and Readability", from_line: 30 }),
  record(1, { label: 0, from_line: 40, to_line: 41, ...model("GPT-5.2") }),
  record(2, { category: "Maintainability and Readability" }),
  record(3, { pr_change_line_count: 900 }),
  record(4, { side: "left" }),
  record(5),
  record(5, { from_line: 20 }),
  record(5, { from_line: 30 }),
  record(5, { from_line: 40 }),
  record(6, { from_line: null, to_line: null }),
  record(7),
  record(8, { project_main_language: "Rust", category: "Security Vulnerability", to_line: null }),
  record(9, { project_main_language: "Rust", category: "Performance" }),
  record(10, { project_main_language: "C", note: "x".repeat(800) }),
]);

export const options = { maxChangeLines: 300, exclude: new Set([`0000007${"b".repeat(33)}`]) };

export const facts: CandidateFacts = {
  base: "c".repeat(40),
  date: "2025-03-01",
  licence: { licence: "MIT", note: "licence MIT read from LICENSE" },
};

// Every comment reachable, unless `blocked` names its line.
export function reaches(
  c: ImportCandidate,
  blocked: ReadonlySet<number> = new Set(),
): ReferenceReach[] {
  return c.instance.references.map((r) => ({
    instance: c.instance.id,
    path: r.path,
    category: r.category,
    reach: blocked.has(r.fromLine ?? 0) ? "outside_diff" : "reachable",
  }));
}

export function candidateFor(pr: number, rows: readonly DatasetRecord[]): ImportCandidate {
  const found = importCandidates(rows, options).find((c) => c.instance.prUrl.endsWith(`/${pr}`));
  if (!found) throw new Error(`fixture lost PR ${pr}`);
  return found;
}
