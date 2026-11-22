import { describe, expect, it } from "vitest";
import { anchored } from "./fix.fakes.js";
import { fixCandidates, MAX_FIX_SPAN_LINES } from "./select.js";

describe("fixCandidates", () => {
  it("takes only findings anchored unambiguously to the change's lines", () => {
    const kept = anchored(2, 2);
    const { lineRange: _, ...unanchored } = anchored(8, 8);
    const findings = [
      kept,
      anchored(3, 3, { anchor: { method: "relocated", inDiff: true } }),
      anchored(4, 4, { anchor: { method: "hunk", inDiff: false } }),
      anchored(5, 5, { anchor: { method: "hunk", inDiff: true, ambiguous: true } }),
      anchored(6, 6, { lowConfidence: true }),
      anchored(7, 7, { fix: { startLine: 7, endLine: 7, replacement: "" } }),
      unanchored,
    ];
    expect(fixCandidates(findings, 10)).toEqual([kept]);
  });

  it("leaves out spans too long to be a local edit", () => {
    const long = anchored(1, 1, { lineRange: { start: 1, end: MAX_FIX_SPAN_LINES + 1 } });
    const longest = anchored(2, 2, { lineRange: { start: 1, end: MAX_FIX_SPAN_LINES } });
    expect(fixCandidates([long, longest], 10)).toEqual([longest]);
  });

  it("asks for the most severe first, within the cap", () => {
    const suggestion = anchored(1, 1, { severity: "suggestion" });
    const critical = anchored(2, 2, { severity: "critical" });
    const warning = anchored(5, 5);
    expect(fixCandidates([suggestion, warning, critical], 2)).toEqual([critical, warning]);
  });
});
