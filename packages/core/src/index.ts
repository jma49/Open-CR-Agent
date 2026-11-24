// The public API of @open-cr-agent/core: what the manual's Embedding and
// Plugins pages build on, a contract under the 0.x rule (Stability page).
// etc/core.api.md records it; a change here updates that report
// (`npm run api`). What the other workspace packages need beyond this comes
// from "@open-cr-agent/core/internal", which is not a contract.

export type { ReviewerOverride, ReviewerOverrides } from "./agent/settings.js";
export {
  type AgentRole,
  EFFORT_LEVELS,
  type RoleSetting,
  type RoleSettings,
  type TierEfforts,
} from "./agent/settings.js";
export { SpendLimitReached } from "./agent/spend-limit.js";
export { addUsage, emptyUsage } from "./agent/usage.js";
export type {
  AgentEvent,
  AgentRuntime,
  AgentTaskSpec,
  AppliedSampling,
  AppliedSettings,
  AttemptRecord,
  CodeMatch,
  CompletionRequest,
  CompletionResult,
  Effort,
  FileSymbols,
  IncompleteEnding,
  ModelChains,
  ModelTier,
  QuotaStop,
  ReferenceIndex,
  ReviewContext,
  Sampling,
  SymbolDefinition,
  SymbolExtractor,
  SymbolKind,
  SymbolReference,
  SyntaxChecker,
  TaskToolset,
  ToolDefinition,
  Usage,
} from "./contracts.js";
export { MODEL_TIERS, SYMBOL_KINDS } from "./contracts.js";
export { GUIDELINE_SCOPES, type GuidelineScope } from "./docs/guidelines.js";
export {
  PROJECT_DOC_LIMITS,
  type ProjectDoc,
  type ProjectDocUse,
} from "./docs/project-docs.js";
export type {
  AnchorMethod,
  ChangeRequest,
  DiffLine,
  FileChangeKind,
  FileDiff,
  Finding,
  FindingFix,
  FindingProvenance,
  FindingRule,
  FindingStatus,
  Hunk,
  LineRange,
  PriorFinding,
  PriorReview,
  QuoteSignature,
  ReportedFinding,
  RiskTier,
  Severity,
  TaskFinding,
  Verdict,
  Verification,
} from "./domain.js";
export {
  CALL_FAILURES,
  type CallFailure,
  CompletionError,
  errorMessage,
  isOcraError,
  OCRA_ERROR_CODES,
  OcraError,
  type OcraErrorCode,
} from "./errors.js";
export { FIX_REJECTIONS, type FixRejection } from "./fix/check.js";
export type { FixSummary } from "./fix/propose.js";
export type { JudgeDecisions } from "./judge/judge.js";
export type { Learning, LearningSource, LearningUse } from "./knowledge/learning.js";
export type { SkippedCell, SkipReason } from "./matrix/matrix.js";
export type { MemoryEntry, MemorySource, RememberedEntry } from "./memory/memory.js";
export {
  MERGE_CHECK_OUTCOMES,
  type MergeCheck,
  type MergeCheckOutcome,
  type MergeCheckResult,
} from "./merge-checks/merge-check.js";
export { fetchFailure } from "./net/fetch-failure.js";
export { type ProxyEnv, proxiedFetch } from "./net/proxied-fetch.js";
export { AccessDeniedError } from "./pipeline/context.js";
export type {
  ReviewLimits,
  ReviewMode,
  ReviewOptions,
  ReviewStages,
  RunIdentity,
} from "./pipeline/options.js";
export type { ProvenanceInput } from "./pipeline/provenance.js";
export type { ResumedRun, ResumedTask } from "./pipeline/resume.js";
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
  ProviderModel,
  RuntimeFactory,
  RuntimeOptions,
  VcsFactory,
} from "./plugin/types.js";
export {
  INLINE_HOLD_REASONS,
  type InlineHoldReason,
  type InlinePolicy,
  type InlineSelection,
} from "./report/inline.js";
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
  isBlocking,
  isIncompleteReview,
  isUnfinished,
  REVIEW_STAGES,
  type ReviewEvent,
  type ReviewReport,
  type ReviewStage,
  type TaskOutcome,
  type TaskStatus,
} from "./report/report.js";
export {
  FINDING_FATES,
  type FindingFate,
  type ReviewTrace,
  type TraceAttempt,
  type TraceCall,
  type TraceFinding,
  type TraceStage,
  type TraceTask,
} from "./report/trace.js";
export {
  isOptionalContext,
  OPTIONAL_CONTEXT,
  type OptionalContext,
} from "./review/context-sources.js";
export type { ReviewerDefinition, ReviewerScope } from "./review/reviewer.js";
export { REVIEW_TOOLS, type ReviewToolName } from "./review/tools.js";
export type { Language } from "./rules/languages.js";
export type { RepoRule, RuleSource, SourcedRule } from "./rules/repo-rules.js";
export type { RuleSet } from "./rules/rule-set.js";
export {
  type AttemptError,
  type AttemptOutcome,
  exploredBy,
  MAX_AGENT_STEPS,
  RESUME_MESSAGE,
  type TaskAttempt,
  type ToolUse,
  WRAP_UP_MESSAGE,
  WRAP_UP_STEPS,
  WRAP_UP_TOOLS,
  type WrapUpOutcome,
  withoutSecrets,
} from "./runtime/attempt.js";
export { ChainRunner, type ModelAttempts } from "./runtime/chain-runner.js";
export {
  type EffortCapability,
  type EffortParameter,
  effortCapability,
  thinkingBudget,
} from "./runtime/effort-capability.js";
export type { RateLimits } from "./runtime/failback.js";
export { type ModelRef, parseModel } from "./runtime/models.js";
export { MAX_QUOTA_WAIT_MS, parseQuotaError, type QuotaError } from "./runtime/quota.js";
export {
  parseTextToolCalls,
  type TextToolCall,
  textToolInstructions,
  textToolResults,
} from "./runtime/text-tools.js";
export { readTools, reviewTools } from "./runtime/tools.js";
export type { AnalyzerEvidenceUse } from "./sarif/evidence.js";
export { parseSarifLog, SarifError, type SarifLog } from "./sarif/schema.js";
export type { ExclusionReason, SelectionPolicy } from "./select/select.js";
export {
  LINKED_TASK_LIMITS,
  type LinkedTask,
  type LinkedTaskUse,
  TASK_TRACKERS,
  type TaskSource,
  type TaskState,
  type TaskTracker,
} from "./task/linked-task.js";
export type {
  ChangeChecks,
  ChangeCommit,
  ChangeConflicts,
  CommitResult,
  ConflictedFile,
  FailedCheck,
  Mention,
  MentionRef,
  RoundNote,
  RoundNoteItem,
  VcsAdapter,
} from "./vcs.js";
export type { RefutedFinding } from "./verify/verify.js";
export type { Walkthrough } from "./walkthrough/walkthrough.js";
