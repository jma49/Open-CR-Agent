import {
  MAX_RULE_TEXT,
  type ReviewUpload,
  redactField,
  type SharedFinding,
} from "@open-cr-agent/cloud-contract";
import type { ReviewReport } from "@open-cr-agent/core";

// The text of each rule the shared findings name (ADR-0080), so ocra Cloud
// can show what a finding applied. A rule is the repository's or the
// account's own words, so it goes only with the findings, redacted and cut
// like them. A learning is named by id alone: ocra Cloud reads its text
// from the repository.
export function sharedRuleTexts(
  report: Pick<ReviewReport, "provenance">,
  findings: readonly SharedFinding[],
): ReviewUpload["provenance"] {
  const named = new Set(findings.flatMap((f) => (f.rule?.kind === "rule" ? [f.rule.id] : [])));
  const rules = Object.fromEntries(
    (report.provenance?.rules ?? []).flatMap(({ id, rule }) =>
      id !== undefined && named.has(id) ? [[id, redactField(rule, MAX_RULE_TEXT).text]] : [],
    ),
  );
  return Object.keys(rules).length > 0 ? { rules } : undefined;
}
