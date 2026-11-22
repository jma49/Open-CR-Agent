import type { Finding, LineRange, Severity } from "../domain.js";

// A longer span is a rewrite, not the local edit a one-click commit should be.
export const MAX_FIX_SPAN_LINES = 30;
export const DEFAULT_MAX_FIXES = 10;

export type FixCandidate = Finding & { lineRange: LineRange };

const SEVERITY_ORDER: Record<Severity, number> = { critical: 0, warning: 1, suggestion: 2 };

// The findings a fix may be asked for, most severe first, at most `max`: only
// those anchored unambiguously to lines the change added or kept, where a
// replacement of exactly those lines is what a suggestion would commit.
export function fixCandidates(findings: readonly Finding[], max: number): FixCandidate[] {
  return findings
    .filter(fixable)
    .sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity])
    .slice(0, max);
}

function fixable(f: Finding): f is FixCandidate {
  return (
    f.lineRange !== undefined &&
    f.lineRange.end - f.lineRange.start < MAX_FIX_SPAN_LINES &&
    f.anchor.method === "hunk" &&
    f.anchor.inDiff &&
    !f.anchor.ambiguous &&
    !f.lowConfidence &&
    !f.fix
  );
}
