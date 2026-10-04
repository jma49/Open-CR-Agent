import type { Finding, ReviewReport, Severity, Verification } from "@open-cr-agent/core";

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

// The same patterns as the server's (ocra-cloud src/redact.ts); the two
// evolve together so the web never shows what this pass would have hidden.
const PATTERNS: readonly RegExp[] = [
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g,
  /\b(AKIA|ASIA)[0-9A-Z]{16}\b/g,
  /\b(ghp|gho|ghs|ghu|ghr)_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bglpat-[A-Za-z0-9_-]{20,}\b/g,
  /\bsk-(ant-|or-|proj-)?[A-Za-z0-9_-]{20,}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
  /\bnpm_[A-Za-z0-9]{36}\b/g,
];

// A long run mixing lower and upper case and digits: a likely key. A hex
// digest (one case) and a path (has a slash) are left alone.
const LONG_RUN = /\b[A-Za-z0-9+/_-]{32,}={0,2}/g;
const looksRandom = (s: string) =>
  /[a-z]/.test(s) && /[A-Z]/.test(s) && /\d/.test(s) && !s.includes("/");

export const REDACTED = "[redacted]";

export function redact(text: string): { text: string; redacted: boolean } {
  let out = text;
  for (const pattern of PATTERNS) out = out.replace(pattern, REDACTED);
  out = out.replace(LONG_RUN, (m) => (looksRandom(m) ? REDACTED : m));
  return { text: out, redacted: out !== text };
}

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
    category: f.category,
    verification: f.verification ?? "unchecked",
    file: f.file,
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
