import type { FileDiff, LineRange, Severity } from "../domain.js";
import { type SarifCandidate, type SarifTool, sarifCandidates } from "./candidates.js";
import type { SarifLog } from "./schema.js";

// Analyzer results shown to reviewers as evidence (ADR-0042): a lead the
// reviewer confirms in the code, never a finding of its own.

// A result just outside a hunk is often what the change makes reachable.
export const EVIDENCE_MARGIN_LINES = 10;
export const MAX_EVIDENCE_PER_BUNDLE = 20;
export const MAX_EVIDENCE_MESSAGE_CHARS = 300;

export interface AnalyzerResult {
  tool: SarifTool;
  file: string;
  lines: LineRange;
  severity: Severity;
  ruleId: string;
  message: string;
  security: boolean;
  // On a hunk's new-side lines, rather than within the margin around one.
  onChange: boolean;
}

// What the report says each tool contributed.
export interface AnalyzerEvidenceUse {
  tool: string;
  version?: string;
  results: number;
  // The labels of the bundles whose tasks were given its results.
  bundles: string[];
}

// A bundle as selection reads it: bundle/ imports review/, which imports this.
interface FileGroup {
  label: string;
  files: readonly FileDiff[];
}

export interface AnalyzerEvidence {
  // A bundle's results, best first; a task sees those on its own files.
  forBundle(bundle: FileGroup): readonly AnalyzerResult[];
  warnings: string[];
}

const noEvidence: AnalyzerEvidence = { forBundle: () => [], warnings: [] };

export function analyzerEvidence(
  logs: readonly SarifLog[],
  bundles: readonly FileGroup[],
): AnalyzerEvidence {
  if (logs.length === 0) return noEvidence;
  const windows = changedLines(bundles.flatMap((b) => b.files));
  const near: AnalyzerResult[] = [];
  const counts = new Map<string, { near: number; given: number; away: number; skipped: number }>();
  const seen = new Set<string>();
  for (const log of logs) {
    for (const run of log.runs) {
      const { tool, candidates, skipped } = sarifCandidates(run);
      const count = counts.get(tool.name) ?? { near: 0, given: 0, away: 0, skipped: 0 };
      counts.set(tool.name, count);
      count.skipped += skipped.noLocation + skipped.unsupportedUri + skipped.noMessage;
      for (const candidate of candidates) {
        const key = [tool.name, candidate.ruleId, candidate.file, candidate.lines.start].join("\0");
        if (seen.has(key)) continue;
        seen.add(key);
        const result = placed(tool, candidate, windows.get(candidate.file) ?? []);
        if (!result) {
          count.away += 1;
          continue;
        }
        count.near += 1;
        near.push(result);
      }
    }
  }
  near.sort(byRelevance);
  const kept = new Set<AnalyzerResult>();
  for (const bundle of bundles) {
    const files = new Set(bundle.files.map((f) => f.newPath));
    for (const r of near.filter((r) => files.has(r.file)).slice(0, MAX_EVIDENCE_PER_BUNDLE)) {
      kept.add(r);
      const count = counts.get(r.tool.name);
      if (count) count.given += 1;
    }
  }
  const given = near.filter((r) => kept.has(r));
  return {
    // A file is in one bundle, so a task never sees more than its bundle's cap.
    forBundle: (bundle) => {
      const files = new Set(bundle.files.map((f) => f.newPath));
      return given.filter((r) => files.has(r.file));
    },
    warnings: [...counts].flatMap(([tool, c]) => evidenceWarning(tool, c)),
  };
}

function placed(
  tool: SarifTool,
  candidate: SarifCandidate,
  ranges: readonly LineRange[],
): AnalyzerResult | undefined {
  const { lines } = candidate;
  const onChange = ranges.some((r) => overlaps(lines, r, 0));
  if (!onChange && !ranges.some((r) => overlaps(lines, r, EVIDENCE_MARGIN_LINES))) return undefined;
  return {
    tool,
    file: candidate.file,
    lines,
    severity: candidate.severity,
    ruleId: candidate.ruleId,
    message: candidate.message.slice(0, MAX_EVIDENCE_MESSAGE_CHARS),
    security: candidate.security,
    onChange,
  };
}

const SEVERITY_ORDER: Record<Severity, number> = { critical: 0, warning: 1, suggestion: 2 };

function byRelevance(a: AnalyzerResult, b: AnalyzerResult): number {
  return (
    Number(b.onChange) - Number(a.onChange) ||
    SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
    Number(b.security) - Number(a.security) ||
    (a.file < b.file ? -1 : a.file > b.file ? 1 : 0) ||
    a.lines.start - b.lines.start ||
    (a.ruleId < b.ruleId ? -1 : a.ruleId > b.ruleId ? 1 : 0)
  );
}

const SECURITY = "security";

// The files a security reviewer reviews in this run's matrix.
export function securityReviewed(
  cells: readonly { reviewer: { category: string }; bundle: FileGroup }[],
): ReadonlySet<string> {
  return new Set(
    cells
      .filter((c) => c.reviewer.category === SECURITY)
      .flatMap((c) => c.bundle.files.map((f) => f.newPath)),
  );
}

// A security-tagged result goes to the security reviewer of its file, and to
// the others only when no security reviewer reviews that file (ADR-0043).
export function evidenceForReviewer(
  results: readonly AnalyzerResult[],
  category: string,
  securityFiles: ReadonlySet<string>,
): AnalyzerResult[] {
  if (category === SECURITY) return [...results];
  return results.filter((r) => !r.security || !securityFiles.has(r.file));
}

// The new-side lines each hunk covers, context included.
export function evidenceUses(
  evidence: AnalyzerEvidence,
  bundles: readonly FileGroup[],
): AnalyzerEvidenceUse[] {
  const uses = new Map<string, AnalyzerEvidenceUse>();
  for (const bundle of bundles) {
    for (const r of evidence.forBundle(bundle)) {
      const use = uses.get(r.tool.name) ?? {
        tool: r.tool.name,
        ...(r.tool.version ? { version: r.tool.version } : {}),
        results: 0,
        bundles: [],
      };
      use.results += 1;
      if (!use.bundles.includes(bundle.label)) use.bundles.push(bundle.label);
      uses.set(r.tool.name, use);
    }
  }
  return [...uses.values()];
}

export function changedLines(diffs: readonly FileDiff[]): Map<string, LineRange[]> {
  const windows = new Map<string, LineRange[]>();
  for (const diff of diffs) {
    const ranges = diff.hunks
      .filter((h) => h.newLines > 0)
      .map((h) => ({ start: h.newStart, end: h.newStart + h.newLines - 1 }));
    if (ranges.length > 0) windows.set(diff.newPath, ranges);
  }
  return windows;
}

export function overlaps(lines: LineRange, range: LineRange, margin: number): boolean {
  return lines.start <= range.end + margin && lines.end >= range.start - margin;
}

function evidenceWarning(
  tool: string,
  c: { near: number; given: number; away: number; skipped: number },
): string[] {
  const left: string[] = [];
  if (c.near > c.given) {
    left.push(`${c.near - c.given} over the limit of ${MAX_EVIDENCE_PER_BUNDLE} per bundle`);
  }
  if (c.away > 0) left.push(`${c.away} away from the change`);
  if (c.skipped > 0) left.push(`${c.skipped} without a file, lines or message`);
  if (left.length === 0) return [];
  return [`${tool}: gave reviewers ${c.given} result(s) as evidence; left out ${left.join(", ")}`];
}
