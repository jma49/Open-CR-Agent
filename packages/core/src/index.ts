// The public API of @open-cr-agent/core: what the manual's Embedding and
// Plugins pages build on, a contract under the 0.x rule (Stability page).
// etc/core.api.md records it; a change here updates that report
// (`npm run api`). What the other workspace packages need beyond this comes
// from "@open-cr-agent/core/internal", which is not a contract.

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
  ModelTier,
  ReviewContext,
  Sampling,
  Usage,
  VcsAdapter,
} from "./contracts.js";
export type {
  AnchorMethod,
  ChangeRequest,
  DiffLine,
  FileChangeKind,
  FileDiff,
  Finding,
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
  isOcraError,
  OCRA_ERROR_CODES,
  OcraError,
  type OcraErrorCode,
} from "./errors.js";
export type { JudgeDecisions } from "./judge/judge.js";
export type { MemoryEntry } from "./memory/memory.js";
export type {
  AgentRole,
  RoleSetting,
  RoleSettings,
  TierEfforts,
} from "./pipeline/agents.js";
export { SpendLimitReached } from "./pipeline/budget.js";
export { AccessDeniedError } from "./pipeline/context.js";
export type {
  ReviewerOverride,
  ReviewerOverrides,
  SkippedCell,
  SkipReason,
} from "./pipeline/matrix.js";
export {
  type OutputFinding,
  type OutputPriorFinding,
  REPORT_VERSION,
  type ReportOutput,
  toReportOutput,
} from "./pipeline/output.js";
export { reportJsonSchema, reportOutputSchema } from "./pipeline/output-schema.js";
export type {
  AgentProvenance,
  ProvenanceInput,
  RunProvenance,
} from "./pipeline/provenance.js";
export {
  type AnchoringSummary,
  type CoverageEntry,
  coverageGaps,
  type ReviewEvent,
  type ReviewReport,
  type TaskOutcome,
  type TaskStatus,
} from "./pipeline/report.js";
export { type ReviewOptions, review } from "./pipeline/run.js";
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
  ModelChains,
  ModelPrice,
  OcraPlugin,
  PluginSummary,
  PostConfigureContext,
  RuntimeFactory,
  RuntimeOptions,
  ToolDefinition,
  VcsFactory,
} from "./plugin/types.js";
export type { ReviewerDefinition, ReviewerScope } from "./review/reviewer.js";
export type { Language } from "./rules/languages.js";
export type { RepoRule } from "./rules/repo-rules.js";
export type { RuleSet } from "./rules/rule-set.js";
export { parseSarifLog, SarifError, type SarifLog } from "./sarif/schema.js";
export type { ExclusionReason, SelectionPolicy } from "./select/select.js";
export type { RefutedFinding } from "./verify/verify.js";
