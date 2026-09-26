import type { Finding, Verdict } from "../domain.js";

export const PATTERN_WARNINGS = 3;

// The rubric is code, so the same findings always give the same verdict and
// a failed judge call cannot change it; it leans towards approval.
export function decideVerdict(findings: readonly Finding[]): Verdict {
  if (findings.some((f) => f.severity === "critical")) return "significant_concerns";
  const warnings = findings.filter((f) => f.severity === "warning").length;
  if (warnings >= PATTERN_WARNINGS) return "minor_issues";
  return findings.length > 0 ? "approved_with_comments" : "approved";
}

export function defaultSummary(findings: readonly Finding[]): string {
  if (findings.length === 0) return "No issues found.";
  const count = (severity: Finding["severity"]) =>
    findings.filter((f) => f.severity === severity).length;
  return `${findings.length} finding(s): ${count("critical")} critical, ${count("warning")} warning, ${count("suggestion")} suggestion.`;
}
