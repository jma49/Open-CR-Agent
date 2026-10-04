// The review conversation every platform adapter shares (ADR-0016), for
// ocra's own adapters. Not a contract yet: a minor release may change it.
export type {
  Bot,
  InlineFinding,
  PlatformChangeRequest,
  PlatformComment,
  PlatformThread,
  PublishedFindings,
  ReviewPlatform,
} from "./platform.js";
export { MAX_ATTEMPTS, type RetryDecision, retryDecision } from "./retry.js";
export {
  type CodeSource,
  type History,
  PlatformReview,
  type PlatformReviewOptions,
} from "./review.js";
export {
  githubSuggestion,
  gitlabSuggestion,
  type SuggestionFence,
} from "./suggestion.js";
