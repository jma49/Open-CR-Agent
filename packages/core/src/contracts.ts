export interface CodeMatch {
  path: string;
  line: number;
  text: string;
}

// The model tiers, strongest first.
export const MODEL_TIERS = ["top", "standard", "light"] as const;
export type ModelTier = (typeof MODEL_TIERS)[number];

// Each tier's failback chain of models, strongest first.
export type ModelChains = { [Tier in ModelTier]?: readonly string[] };

// How much a model reasons before it answers (ADR-0025). Unset leaves the
// provider's default; "none" asks for no reasoning where a provider can say so.
export type Effort = "none" | "minimal" | "low" | "medium" | "high";

export interface AgentTaskSpec {
  taskId: string;
  // The agent the task runs for: its settings and what was applied are kept
  // under this id.
  reviewer: string;
  modelTier: ModelTier;
  // Absent: the runtime sends no effort.
  effort?: Effort;
  // The agent's own failback chain (ADR-0025); absent: the tier's. A runtime
  // that does not read it uses the tier's chain.
  models?: readonly string[];
  systemPrompt: string;
  userPrompt: string;
  context: ReviewContext;
  timeoutMs: number;
}

export interface ReviewContext {
  readFile(path: string): Promise<string | undefined>;
  readDiff(path: string): string | undefined;
  searchCode(literal: string): Promise<CodeMatch[]>;
}

// How a review task that finished without the done tool ended: its agent
// used every step (step_cap), or stopped with steps left (stopped_early; one
// that stopped silently was first told once to continue).
export const INCOMPLETE_ENDINGS = ["step_cap", "stopped_early"] as const;
export type IncompleteEnding = (typeof INCOMPLETE_ENDINGS)[number];

// What one attempt of a review task looked at and answered: the files it
// read, the literals it searched for and its final text. Kept in the session
// log, never in the report, so an analysis can tell a file the reviewer never
// read from one it read and reported nothing on.
export interface AttemptRecord {
  model: string;
  read: string[];
  searched: string[];
  text: string;
}

export type AgentEvent =
  // attempt: on the line that sums up a finished attempt.
  | { type: "progress"; taskId: string; message: string; attempt?: AttemptRecord }
  // model: the one that reported the finding, when the runtime knows it.
  | { type: "finding"; taskId: string; finding: unknown; model?: string }
  | ({ type: "usage"; taskId: string } & Usage)
  // ended: absent when the agent called the done tool; otherwise how it
  // stopped without it, so its files count as only partly reviewed.
  | { type: "done"; taskId: string; ended?: IncompleteEnding }
  | { type: "error"; taskId: string; error: string; retryable: boolean };

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cachedTokens: number;
  costUsd: number;
}

export interface CompletionRequest {
  tier: ModelTier;
  // The agent the call is made for: a reviewer id (its plan call), or the
  // role "verifier", "judge" or "helper".
  agent?: string;
  effort?: Effort;
  // The agent's own failback chain; absent: the tier's.
  models?: readonly string[];
  system: string;
  user: string;
  timeoutMs: number;
}

export interface CompletionResult {
  text: string;
  usage: Usage;
}

// Sampling settings for model calls. Unset fields leave the provider's
// default; a review sets none unless configured, the evaluation sets both.
export interface Sampling {
  temperature?: number;
  seed?: number;
}

// What a runtime sends with every call: the requested settings it applies,
// and the names of those it cannot pass on.
export interface AppliedSampling extends Sampling {
  notApplied?: (keyof Sampling)[];
}

// What a runtime did with one agent's calls over the run.
export interface AppliedSettings {
  // Every call that asked for an effort sent it; false when one went
  // without: the endpoint refused the parameter, or the runtime had no way
  // to send that level to the model (`unsupported`).
  effort: boolean;
  // Models the agent's level was not sent to because, as far as the runtime
  // knows (the capability table, ADR-0025), they do not take it.
  unsupported?: string[];
  // Why the level was not sent, when the runtime knows a cause other than
  // the capability table (OpenCode's catalog could not be read, say).
  unsentBecause?: string;
  // Sampling settings left out of the agent's calls: a call that sends an
  // effort other than "none" sends no temperature or seed.
  notApplied?: (keyof Sampling)[];
}

export interface AgentRuntime {
  readonly name: string;
  // Absent: the runtime applies none of the requested sampling settings.
  readonly sampling?: AppliedSampling;
  // What the runtime applied for an agent that asked for an effort; undefined
  // when that agent made no such call. Absent: the runtime sends no effort.
  appliedTo?(agent: string): AppliedSettings | undefined;
  runTask(spec: AgentTaskSpec, signal: AbortSignal): AsyncIterable<AgentEvent>;
  // Throws a CompletionError carrying the usage of failed attempts.
  complete?(request: CompletionRequest, signal: AbortSignal): Promise<CompletionResult>;
  dispose?(): Promise<void>;
}
