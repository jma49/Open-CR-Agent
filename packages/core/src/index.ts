// The public API of @open-cr-agent/core: what the manual's Embedding and
// Plugins pages build on, a contract under the 0.x rule (Stability page).
// etc/core.api.md records it; a change here updates that report
// (`npm run api`). What the other workspace packages need beyond this comes
// from "@open-cr-agent/core/internal", which is not a contract.

export { SpendLimitReached } from "./agent/budget.js";
export type { ReviewerOverride, ReviewerOverrides } from "./agent/settings.js";
export {
  type AgentRole,
  EFFORT_LEVELS,
  type RoleSetting,
  type RoleSettings,
  type TierEfforts,
} from "./agent/settings.js";
export { addUsage, emptyUsage } from "./agent/usage.js";
export type {
  AgentEvent,
  AgentRuntime,
  AgentTaskSpec,
  AppliedSampling,
  AppliedSettings,
  CodeMatch,
  CompletionRequest,
  CompletionResult,
  Effort,
  IncompleteEnding,
  ModelChains,
  ModelTier,
  ReviewContext,
  Sampling,
  Usage,
} from "./contracts.js";
export { MODEL_TIERS } from "./contracts.js";
export type {
  AnchorMethod,
  ChangeRequest,
  DiffLine,
  FileChangeKind,
  FileDiff,
  Finding,
  FindingFix,
  FindingProvenance,
  FindingStatus,
  Hunk,
  LineRange,
  PriorFinding,
  PriorReview,
  QuoteSignature,
  ReportedFinding,
  RiskTier,
  Severity,
  Verdict,
  Verification,
} from "./domain.js";
export {
  CompletionError,
  errorMessage,
  isOcraError,
  OCRA_ERROR_CODES,
  OcraError,
  type OcraErrorCode,
} from "./errors.js";
export type { JudgeDecisions } from "./judge/judge.js";
export type { MemoryEntry, MemorySource, RememberedEntry } from "./memory/memory.js";
export { type ProxyEnv, proxiedFetch } from "./net/proxied-fetch.js";
export { AccessDeniedError } from "./pipeline/context.js";
export type { SkippedCell, SkipReason } from "./pipeline/matrix.js";
export type {
  ReviewLimits,
  ReviewMode,
  ReviewOptions,
  ReviewStages,
  RunIdentity,
} from "./pipeline/options.js";
export type { ProvenanceInput } from "./pipeline/provenance.js";
export { review } from "./pipeline/run.js";
export {
  agentsMdReviewerPlugin,
  correctnessReviewerPlugin,
  docsReviewerPlugin,
  performanceReviewerPlugin,
  securityReviewerPlugin,
  sessionJsonlPlugin,
} from "./plugin/builtin.js";
export { type PluginHostOptions, startPlugins } from "./plugin/host.js";
export { PluginError, PluginRegistry } from "./plugin/registry.js";
export type {
  BootstrapContext,
  ConfigureContext,
  CustomProvider,
  Env,
  ModelPrice,
  OcraPlugin,
  PluginSummary,
  PostConfigureContext,
  RuntimeFactory,
  RuntimeOptions,
  ToolDefinition,
  VcsFactory,
} from "./plugin/types.js";
export {
  type OutputFinding,
  type OutputPriorFinding,
  type ReportOutput,
  toReportOutput,
} from "./report/output.js";
export { REPORT_VERSION, reportJsonSchema, reportOutputSchema } from "./report/output-schema.js";
export type { AgentProvenance, RuleProvenance, RunProvenance } from "./report/provenance.js";
export {
  type AnchoringSummary,
  type CoverageEntry,
  coverageGaps,
  isUnfinished,
  type ReviewEvent,
  type ReviewReport,
  type TaskOutcome,
  type TaskStatus,
} from "./report/report.js";
export type { ReviewerDefinition, ReviewerScope } from "./review/reviewer.js";
export { REVIEW_TOOLS, type ReviewToolName } from "./review/tools.js";
export type { Language } from "./rules/languages.js";
export type { RepoRule, RuleSource, SourcedRule } from "./rules/repo-rules.js";
export type { RuleSet } from "./rules/rule-set.js";
export {
  type AttemptError,
  type AttemptOutcome,
  MAX_AGENT_STEPS,
  RESUME_MESSAGE,
  withoutSecrets,
} from "./runtime/attempt.js";
export { ChainRunner, type ModelAttempts } from "./runtime/chain-runner.js";
export {
  type EffortCapability,
  type EffortParameter,
  effortCapability,
  thinkingBudget,
} from "./runtime/effort-capability.js";
export { type ModelRef, parseModel } from "./runtime/models.js";
export { parseQuotaError, type QuotaError } from "./runtime/quota.js";
export { reviewTools } from "./runtime/tools.js";
export { parseSarifLog, SarifError, type SarifLog } from "./sarif/schema.js";
export type { ExclusionReason, SelectionPolicy } from "./select/select.js";
export type { VcsAdapter } from "./vcs.js";
export type { RefutedFinding } from "./verify/verify.js";
