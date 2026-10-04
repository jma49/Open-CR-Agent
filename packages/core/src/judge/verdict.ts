import type { Finding, Severity, Verdict, Verification } from "../domain.js";

const PATTERN_WARNINGS = 3;

export interface VerdictInput {
  severity: Severity;
  verification?: Verification;
}

// The rubric is code, so the same findings always give the same verdict and
// a failed judge call cannot change it; it leans towards approval. Only a
// critical finding the verifier confirmed blocks: one model's unchecked claim
// (possibly planted by the change itself) should not fail a pull request.
export function decideVerdict(findings: readonly VerdictInput[]): Verdict {
  const critical = findings.filter((f) => f.severity === "critical");
  if (critical.some((f) => f.verification === "confirmed")) return "significant_concerns";
  if (critical.length > 0) return "minor_issues";
  const warnings = findings.filter((f) => f.severity === "warning").length;
  if (warnings >= PATTERN_WARNINGS) return "minor_issues";
  return findings.length > 0 ? "approved_with_comments" : "approved";
}

export function defaultSummary(findings: readonly Finding[], stillOpen = 0): string {
  if (findings.length === 0) {
    return stillOpen > 0
      ? `No new issues; ${stillOpen} earlier finding(s) are still open.`
      : "No issues found.";
  }
  const count = (severity: Finding["severity"]) =>
    findings.filter((f) => f.severity === severity).length;
  return `${findings.length} finding(s): ${count("critical")} critical, ${count("warning")} warning, ${count("suggestion")} suggestion.`;
}
