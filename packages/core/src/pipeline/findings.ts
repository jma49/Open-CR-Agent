import { createHash, randomUUID } from "node:crypto";
import type { Anchor } from "../anchor/anchor.js";
import { normalizeSnippet } from "../anchor/match.js";
import type { Finding, ReportedFinding, Severity } from "../domain.js";

const SEVERITY_RANK: Record<Severity, number> = { suggestion: 0, warning: 1, critical: 2 };

export function fingerprint(category: string, file: string, existingCode: string): string {
  const key = [category, file, ...normalizeSnippet(existingCode)].join("\n");
  return createHash("sha256").update(key).digest("hex").slice(0, 16);
}

export function toFinding(reported: ReportedFinding, reviewer: string, anchor: Anchor): Finding {
  const finding: Finding = {
    ...reported,
    file: anchor.file,
    id: randomUUID(),
    fingerprint: fingerprint(reported.category, anchor.file, reported.existingCode),
    reviewer,
    anchor: { method: anchor.method, inDiff: anchor.inDiff },
    status: "new",
  };
  if (anchor.lineRange) finding.lineRange = anchor.lineRange;
  return finding;
}

export function dedupeFindings(findings: readonly Finding[]): Finding[] {
  const byFingerprint = new Map<string, Finding>();
  for (const finding of findings) {
    const existing = byFingerprint.get(finding.fingerprint);
    if (!existing) byFingerprint.set(finding.fingerprint, finding);
    else if (SEVERITY_RANK[finding.severity] > SEVERITY_RANK[existing.severity]) {
      byFingerprint.set(finding.fingerprint, { ...existing, severity: finding.severity });
    }
  }
  return [...byFingerprint.values()];
}
