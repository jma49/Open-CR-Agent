// "@open-cr-agent/vcs-platform/internal": what the platform adapters' tests
// check against. Not a contract: any release may change it.
export { safeMarkdown } from "./neutralize.js";
export { renderSummary } from "./render.js";
export { declinesFinding } from "./review.js";
export { MAX_WRITTEN_STATE_CHARS, readState, SUMMARY_MARKER, writeState } from "./state.js";
