import type { Finding, ReviewReport, Severity, Verification } from "@open-cr-agent/core";
import { redact } from "./redact.js";

export { REDACTED, redact } from "./redact.js";

// The findings a review sends ocra Cloud when the account shares them
// (ADR-0028, 2): what the web needs to show the review, after a redaction
// pass and within the server's bounds. The server redacts and bounds again;
// this pass keeps a secret from leaving the machine at all. It catches
// patterns, not every secret.

export type SharedFinding = {
  fingerprint: string;
  reviewer: string;
  severity: Severity;
  category: string;
  verification: Verification;
  file: string;
  lineStart: number | null;
  lineEnd: number | null;
  title: string;
  body: string;
  suggestion: string | null;
  code: string;
  redacted?: true;
  truncated?: true;
};

export const MAX_FINDINGS = 200;
export const MAX_FIELD = 4_096;
export const MAX_TOTAL_BYTES = 262_144;

/** The report's findings as uploaded, redacted and bounded; `left` counts those not sent. */
export function sharedFindings(report: Pick<ReviewReport, "findings">): {
  findings: SharedFinding[];
  left: number;
} {
  const findings: SharedFinding[] = [];
  let total = 0;
  for (const finding of report.findings.slice(0, MAX_FINDINGS)) {
    const shared = share(finding);
    const size = textBytes(shared);
    if (total + size > MAX_TOTAL_BYTES) break;
    total += size;
    findings.push(shared);
  }
  return { findings, left: report.findings.length - findings.length };
}

function share(f: Finding): SharedFinding {
  let redacted = false;
  let truncated = false;
  const text = (value: string): string => {
    const r = redact(value);
    redacted ||= r.redacted;
    if (r.text.length <= MAX_FIELD) return r.text;
    truncated = true;
    const cut = r.text.slice(0, MAX_FIELD);
    // Never leave half of a surrogate pair at the cut.
    return /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut;
  };
  const shared: SharedFinding = {
    fingerprint: f.fingerprint,
    reviewer: f.reviewer,
    severity: f.severity,
    category: text(f.category),
    verification: f.verification ?? "unchecked",
    file: text(f.file),
    lineStart: f.lineRange?.start ?? null,
    lineEnd: f.lineRange?.end ?? null,
    title: text(f.title),
    body: text(f.body),
    suggestion: f.suggestion === undefined ? null : text(f.suggestion),
    code: text(f.existingCode),
  };
  if (redacted) shared.redacted = true;
  if (truncated) shared.truncated = true;
  return shared;
}

// Bytes as sent, escapes included, so the body stays under the server's limit.
function textBytes(f: SharedFinding): number {
  return [f.title, f.body, f.suggestion ?? "", f.code].reduce(
    (sum, s) => sum + Buffer.byteLength(JSON.stringify(s)),
    0,
  );
}
