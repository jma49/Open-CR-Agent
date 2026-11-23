import { z } from "zod";
import { type Finding, type Severity, severitySchema, type Verification } from "../domain.js";

// Which findings a platform may post as inline comments (ADR-0076). A
// policy never removes a finding from the report or changes the verdict: a
// finding it holds back is listed in the summary instead.

export const INLINE_HOLD_REASONS = ["below_floor", "over_cap"] as const;
export type InlineHoldReason = (typeof INLINE_HOLD_REASONS)[number];

export interface InlinePolicy {
  // Only findings at least this severe are posted inline.
  minSeverity?: Severity;
  // At most this many of the review's findings are posted inline; 0 posts none.
  maxComments?: number;
}

export interface InlineSelection extends InlinePolicy {
  // The findings that could be posted inline but are not, in ranking order.
  held: { fingerprint: string; reason: InlineHoldReason }[];
}

export const inlineSelectionSchema = z.strictObject({
  minSeverity: severitySchema.exactOptional(),
  maxComments: z.int().nonnegative().exactOptional(),
  held: z.array(z.strictObject({ fingerprint: z.string(), reason: z.enum(INLINE_HOLD_REASONS) })),
});

const SEVERITY_RANK: Record<Severity, number> = { critical: 0, warning: 1, suggestion: 2 };
const VERIFICATION_RANK: Record<Verification, number> = {
  confirmed: 0,
  uncertain: 1,
  unchecked: 2,
};

// More severe first, then what Verify confirmed, then what the judge did not
// mark low confidence, then by place and fingerprint, so the order does not
// depend on the order tasks ended in.
function compareForInline(a: Finding, b: Finding): number {
  return (
    SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
    VERIFICATION_RANK[a.verification ?? "unchecked"] -
      VERIFICATION_RANK[b.verification ?? "unchecked"] ||
    Number(a.lowConfidence === true) - Number(b.lowConfidence === true) ||
    compareText(a.file, b.file) ||
    (a.lineRange?.start ?? 0) - (b.lineRange?.start ?? 0) ||
    compareText(a.fingerprint, b.fingerprint)
  );
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** A finding a platform can comment on inline: anchored to lines in the diff. */
function postableInline(f: Finding): boolean {
  return f.lineRange !== undefined && f.anchor.inDiff;
}

/**
 * The findings a policy holds back from inline comments: those below its
 * floor, then those past its cap among the rest when ranked. The cap counts
 * this review's findings, so one commented on in an earlier review and
 * reported again takes a place without being posted twice. Undefined
 * without a policy.
 */
export function selectInline(
  findings: readonly Finding[],
  policy: InlinePolicy,
): InlineSelection | undefined {
  const { minSeverity, maxComments } = policy;
  if (minSeverity === undefined && maxComments === undefined) return undefined;
  const ranked = findings.filter(postableInline).sort(compareForInline);
  const held: InlineSelection["held"] = [];
  let kept = 0;
  for (const f of ranked) {
    if (minSeverity !== undefined && SEVERITY_RANK[f.severity] > SEVERITY_RANK[minSeverity]) {
      held.push({ fingerprint: f.fingerprint, reason: "below_floor" });
    } else if (maxComments !== undefined && kept >= maxComments) {
      held.push({ fingerprint: f.fingerprint, reason: "over_cap" });
    } else {
      kept += 1;
    }
  }
  return {
    ...(minSeverity !== undefined ? { minSeverity } : {}),
    ...(maxComments !== undefined ? { maxComments } : {}),
    held,
  };
}
