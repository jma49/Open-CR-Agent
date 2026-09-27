import { createHash, randomUUID } from "node:crypto";
import type { Anchor } from "../anchor/anchor.js";
import { normalizeSnippet } from "../anchor/match.js";
import type { Finding, ReportedFinding, Severity } from "../domain.js";
import { quoteSignature } from "../rereview/quote.js";

const SEVERITY_RANK: Record<Severity, number> = { suggestion: 0, warning: 1, critical: 2 };

export function fingerprint(category: string, file: string, existingCode: string): string {
  const key = [category, file, ...normalizeSnippet(existingCode)].join("\n");
  return createHash("sha256").update(key).digest("hex").slice(0, 16);
}

// content is the anchored file at head, when the anchor found lines in it.
export function toFinding(
  reported: ReportedFinding,
  reviewer: string,
  anchor: Anchor,
  content?: string,
): Finding {
  const finding: Finding = {
    ...reported,
    file: anchor.file,
    id: randomUUID(),
    fingerprint: fingerprint(reported.category, anchor.file, reported.existingCode),
    reviewer,
    anchor: { method: anchor.method, inDiff: anchor.inDiff },
    status: "new",
  };
  if (anchor.lineRange) {
    finding.lineRange = anchor.lineRange;
    const quote = content === undefined ? undefined : quoteSignature(content, anchor.lineRange);
    if (quote) finding.quote = quote;
  }
  return finding;
}

// The most severe copy wins whole: its title and explanation describe the
// severity it carries.
export function dedupeFindings(findings: readonly Finding[]): Finding[] {
  const byFingerprint = new Map<string, Finding>();
  for (const finding of findings) {
    const existing = byFingerprint.get(finding.fingerprint);
    if (!existing || SEVERITY_RANK[finding.severity] > SEVERITY_RANK[existing.severity]) {
      byFingerprint.set(finding.fingerprint, finding);
    }
  }
  return [...byFingerprint.values()];
}
