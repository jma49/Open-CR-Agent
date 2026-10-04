// "@open-cr-agent/core/internal": what ocra's own packages share beyond the
// public API (index.ts). Not a contract: any release may change or remove
// any of it, and nothing outside this repository should import it.

export { parseUnifiedDiff } from "./diff/parse.js";
export { severitySchema, verificationSchema } from "./domain.js";
export { errorMessage, usageSpent } from "./errors.js";
export {
  MEMORY_PATH,
  memoryEntrySchema,
  parseMemory,
  serializeMemory,
} from "./memory/memory.js";
export { proxiedFetch } from "./net/proxied-fetch.js";
export { AGENT_ROLES, EFFORT_LEVELS } from "./pipeline/agents.js";
export { reviewContext } from "./pipeline/context.js";
export { RISK_TIERS } from "./pipeline/matrix.js";
export {
  isUnsafeCodePoint,
  type PlanOutput,
  serializeOutput,
  toPlanOutput,
} from "./pipeline/output.js";
export { previewReview, type ReviewPreview } from "./pipeline/preview.js";
export { stableHash } from "./pipeline/provenance.js";
export { newRunId } from "./pipeline/run-id.js";
export { addUsage, emptyUsage } from "./pipeline/usage.js";
export { REVIEW_TOOLS } from "./review/tools.js";
export { repoRuleSchema } from "./rules/repo-rules.js";
export {
  type AttemptOutcome,
  MAX_AGENT_STEPS,
  RESUME_MESSAGE,
  withoutSecrets,
} from "./runtime/attempt.js";
export { thinkingBudget } from "./runtime/effort-capability.js";
export { completeWithFailback, withFailback } from "./runtime/failback.js";
export { callChain, ModelHealth, parseModel } from "./runtime/models.js";
export { parseQuotaError, type QuotaError, sleep } from "./runtime/quota.js";
export { MAX_READ_LINES, reviewTools } from "./runtime/tools.js";
export { defaultSelectionPolicy } from "./select/select.js";
export { REPORT_FILE } from "./session/jsonl.js";
