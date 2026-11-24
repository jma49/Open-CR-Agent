// "@open-cr-agent/vcs-platform/internal": what the platform adapters' tests
// check against. Not a contract: any release may change it.

export { type CheckOutcome, checkOutcome, runningOutcome, stoppedOutcome } from "./check.js";
export { LOG_TAIL_BYTES } from "./checks.js";
export { declinesFinding } from "./declined.js";
export {
  type PlatformApi,
  pageInfoSchema,
  sendWithRetry,
} from "./http.js";
export { safeMarkdown } from "./neutralize.js";
export { renderSummary } from "./render.js";
export { MAX_WRITTEN_STATE_CHARS, readState, SUMMARY_MARKER, writeState } from "./state.js";
