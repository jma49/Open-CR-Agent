// "@open-cr-agent/core/internal": what ocra's own packages share beyond the
// public API (index.ts). Not a contract: any release may change or remove
// any of it, and nothing outside this repository should import it.

export { AGENT_ROLES } from "./agent/settings.js";
export { parseUnifiedDiff } from "./diff/parse.js";
export { severitySchema, verificationSchema } from "./domain.js";
export { errorMessage, usageSpent } from "./errors.js";
export {
  MEMORY_PATH,
  memoryEntrySchema,
  parseMemory,
  serializeMemory,
} from "./memory/memory.js";
export { reviewContext } from "./pipeline/context.js";
export { RISK_TIERS } from "./pipeline/matrix.js";
export { MAX_TIMER_MS, REVIEW_DEFAULTS } from "./pipeline/options.js";
export { type PlanOutput, toPlanOutput } from "./pipeline/plan-output.js";
export { previewReview, type ReviewPreview } from "./pipeline/preview.js";
export { stableHash } from "./pipeline/provenance.js";
export { newRunId } from "./pipeline/run-id.js";
export { isUnsafeCodePoint, serializeOutput } from "./report/serialize.js";
export { repoRuleSchema } from "./rules/repo-rules.js";
export { sleep } from "./runtime/quota.js";
export { REPORT_FILE } from "./session/jsonl.js";
