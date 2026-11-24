import {
  FINGERPRINT,
  MAX_EVIDENCE,
  MAX_EVIDENCE_FIELD,
  MAX_FINDINGS,
  MAX_TOTAL_BYTES,
  redactField,
  type SharedFinding,
  type SharedFix,
} from "@open-cr-agent/cloud-contract";
import type { Finding, ReviewReport } from "@open-cr-agent/core";
import { reviewerOutcomes } from "../reviewer-outcomes.js";

// The findings a review sends ocra Cloud when the account shares them
// (ADR-0028, 2): what the web needs to show the review, after the contract's
// redaction pass and within its bounds. The server redacts and bounds again;
// this pass keeps a secret from leaving the machine at all. It catches
// patterns, not every secret.

export type SharedFindings = { findings: SharedFinding[]; left: number };

/** The report's findings as uploaded, redacted and bounded; `left` counts those not sent. */
export function sharedFindings(report: Pick<ReviewReport, "findings">): SharedFindings {
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

/**
 * The fingerprints of the earlier findings this review saw fixed or
 * dismissed, counted as the upload's outcomes count them, so ocra Cloud can
 * mark the findings it holds under them.
 */
export function sharedOutcomes(report: ReviewReport): {
  fixedFingerprints: string[];
  dismissedFingerprints: string[];
} {
  const { fixedFingerprints, dismissedFingerprints } = reviewerOutcomes([report]);
  const bounded = (fps: string[]) =>
    fps.filter((fp) => FINGERPRINT.test(fp)).slice(0, MAX_FINDINGS);
  return {
    fixedFingerprints: bounded(fixedFingerprints),
    dismissedFingerprints: bounded(dismissedFingerprints),
  };
}

function share(f: Finding): SharedFinding {
  let redacted = false;
  let truncated = false;
  const text = (value: string, max?: number): string => {
    const r = redactField(value, max);
    redacted ||= r.redacted;
    truncated ||= r.truncated;
    return r.text;
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
  const fix = shareableFix(f);
  if (fix) shared.fix = fix;
  const facts = f.evidence.map((e) => e.replace(/\s+/g, " ").trim()).filter(Boolean);
  if (facts.length > 0) {
    shared.evidence = facts.slice(0, MAX_EVIDENCE).map((e) => text(e, MAX_EVIDENCE_FIELD));
  }
  if (f.rule) shared.rule = { kind: f.rule.kind, id: f.rule.id };
  if (f.lowConfidence) shared.lowConfidence = true;
  if (redacted) shared.redacted = true;
  if (truncated) shared.truncated = true;
  return shared;
}

// A fix is code a click may commit, so one the redaction pass would change
// is left out rather than sent changed.
function shareableFix({ fix }: Finding): SharedFix | undefined {
  if (!fix) return undefined;
  const r = redactField(fix.replacement);
  if (r.redacted || r.truncated) return undefined;
  return { startLine: fix.startLine, endLine: fix.endLine, replacement: fix.replacement };
}

// Bytes as sent, escapes included, so the body stays under the server's limit.
function textBytes(f: SharedFinding): number {
  return [
    f.title,
    f.body,
    f.suggestion ?? "",
    f.code ?? "",
    f.fix?.replacement ?? "",
    ...(f.evidence ?? []),
  ].reduce((sum, s) => sum + Buffer.byteLength(JSON.stringify(s)), 0);
}
