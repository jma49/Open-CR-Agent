// The review conversation every platform adapter shares (ADR-0016), for
// ocra's own adapters. Not a contract yet: a minor release may change it.

export {
  changeRequestSchema,
  codeSourceSchema,
  commitIdSchema,
  fetchSchema,
  historySchema,
  mergeSourceSchema,
  signalSchema,
} from "./options.js";
export type {
  Bot,
  InlineFinding,
  PlatformChangeRequest,
  PlatformCheck,
  PlatformComment,
  PlatformDiscussion,
  PlatformThread,
  PublishedFindings,
  ReviewPlatform,
} from "./platform.js";
export type { FileProposal, ProposedChange, ProposeOptions } from "./proposal.js";
export { MAX_ATTEMPTS, type RetryDecision, retryDecision } from "./retry.js";
export {
  type CodeSource,
  type History,
  type MergeSource,
  PlatformReview,
  type PlatformReviewOptions,
} from "./review.js";
export {
  pickStacked,
  type StackedChangeRequest,
  type StackHost,
} from "./stack.js";
export {
  githubSuggestion,
  gitlabSuggestion,
  type SuggestionFence,
} from "./suggestion.js";
export type {
  ChangeRequestRef,
  LocalCode,
  PlatformTarget,
  ResolveTargetOptions,
} from "./target.js";
