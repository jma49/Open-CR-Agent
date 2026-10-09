// "@open-cr-agent/core/internal": what ocra's own packages share beyond the
// public API (index.ts). Not a contract: any release may change or remove
// any of it, and nothing outside this repository should import it.

export { AGENT_ROLES } from "./agent/settings.js";
export { at } from "./at.js";
export { parseUnifiedDiff } from "./diff/parse.js";
export { severitySchema, verificationSchema } from "./domain.js";
export { errnoCode, isNotFound } from "./errors.js";
export { shortHash } from "./hash.js";
export {
  MEMORY_PATH,
  memoryEntrySchema,
  parseMemory,
  serializeMemory,
} from "./memory/memory.js";
export { reviewContext } from "./pipeline/context.js";
export { RISK_TIERS } from "./pipeline/matrix.js";
export { MAX_TIMER_MS, REVIEW_DEFAULTS } from "./pipeline/options.js";
export {
  PLAN_VERSION,
  planOutputSchema,
  toPlanOutput,
} from "./pipeline/plan-output.js";
export { previewReview, type ReviewPreview } from "./pipeline/preview.js";
export { stableHash } from "./pipeline/provenance.js";
export { newRunId } from "./pipeline/run-id.js";
export { readReport } from "./report/read.js";
export { unconfirmedCriticals } from "./report/report.js";
export { isUnsafeCodePoint, serializeOutput } from "./report/serialize.js";
export { reconcile } from "./rereview/reconcile.js";
export { repoRuleSchema } from "./rules/repo-rules.js";
export { EVENTS_FILE, REPORT_FILE } from "./session/jsonl.js";
export { readResumedRun } from "./session/resume-read.js";
