import {
  MAX_WALKTHROUGH_FILES,
  MAX_WALKTHROUGH_GROUPS,
  redactField,
  type SharedWalkthrough,
} from "@open-cr-agent/cloud-contract";
import type { Walkthrough } from "@open-cr-agent/core";

// The walkthrough a review sends with its findings (ADR-0047): model text
// about the change, so it takes the findings' redaction pass and bounds.
export function sharedWalkthrough(walkthrough: Walkthrough): SharedWalkthrough {
  let redacted = false;
  let truncated = false;
  const text = (value: string): string => {
    const r = redactField(value);
    redacted ||= r.redacted;
    truncated ||= r.truncated;
    return r.text;
  };
  const shared: SharedWalkthrough = {
    overview: text(walkthrough.overview),
    groups: walkthrough.groups.slice(0, MAX_WALKTHROUGH_GROUPS).map((g) => ({
      title: text(g.title),
      files: g.files.slice(0, MAX_WALKTHROUGH_FILES).map((f) => redactField(f, 1024).text),
      note: text(g.note),
    })),
    diagram: walkthrough.diagram === undefined ? null : text(walkthrough.diagram),
  };
  if (redacted) shared.redacted = true;
  if (truncated) shared.truncated = true;
  return shared;
}
