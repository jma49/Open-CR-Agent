import type { z } from "zod";
export interface CodeMatch {
  path: string;
  line: number;
  text: string;
}

export const SYMBOL_KINDS = [
  "function",
  "method",
  "class",
  "interface",
  "type",
  "enum",
  "module",
  "variable",
] as const;
export type SymbolKind = (typeof SYMBOL_KINDS)[number];

// Lines are 1-based and inclusive.
export interface SymbolDefinition {
  name: string;
  kind: SymbolKind;
  startLine: number;
  endLine: number;
}

// What a parser found in one file: its definitions, and the lines on which
// each identifier occurs outside comments and strings.
export interface FileSymbols {
  definitions: readonly SymbolDefinition[];
  uses: ReadonlyMap<string, readonly number[]>;
}

// Parses files into symbols for the impact analysis; undefined when it does
// not know the file's language.
export interface SymbolExtractor {
  symbols(path: string, content: string): Promise<FileSymbols | undefined>;
}

// Counts the syntax errors a parser finds in one file; undefined when it does
// not know the file's language or gives up on it.
export interface SyntaxChecker {
  errors(path: string, content: string): Promise<number | undefined>;
}

export interface SymbolReference {
  path: string;
  line: number;
}

// Uses of a symbol from an index of the repository built before the
// review (a SCIP index, or ocra's code graph), at the revision it was built
// from: the uses of the symbol `name` that `path` defines, outside that
// file; undefined when the index has no such definition.
export interface ReferenceIndex {
  usesOf(path: string, name: string): Promise<readonly SymbolReference[] | undefined>;
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
  // Where in userPrompt a start that other tasks of the run are given too
  // ends, shortest first (ADR-0064), then where the start the task's plan
  // call sent ends (ADR-0066). A runtime whose provider caches the prefixes
  // it is shown marks them; any other leaves them alone.
  sharedPrefixes?: readonly number[];
  context: ReviewContext;
  // The task's own tools in place of the review's. Only a runtime that
  // declares `toolsets` reads it.
  toolset?: TaskToolset;
  timeoutMs: number;
}

export interface ToolDefinition<Shape extends z.ZodRawShape = z.ZodRawShape> {
  name: string;
  description: string;
  inputSchema: z.ZodObject<Shape>;
  execute(args: z.infer<z.ZodObject<Shape>>, context: ReviewContext): Promise<string>;
}

// What a task that is not a review works with (ADR-0078): the review's tools
// that read the change (file, diff, search), and these. They include the
// done tool under the review's name for it. No tool that reports a finding
// and no plugin's tool joins them.
export interface TaskToolset {
  tools: readonly ToolDefinition[];
  // Sent once to an agent that stops with steps left, no done call and no answer.
  resume: string;
  // The one more turn an attempt gets when it ends without the done tool,
  // and the names of the tools it offers.
  wrapUp: { message: string; tools: readonly string[] };
}

export interface ReviewContext {
  readFile(path: string): Promise<string | undefined>;
  readDiff(path: string): string | undefined;
  searchCode(literal: string): Promise<CodeMatch[]>;
  // One of the run's learnings (ADR-0037) by id: its title, then its body.
  // Absent, as in a context that holds none.
  readLearning?(id: string): string | undefined;
}

// How a review task that finished without the done tool ended: its agent
// used every step (step_cap), filled its model's declared context window
// (context_window), or stopped with steps left (stopped_early; one that
// stopped silently was first told once to continue).
export const INCOMPLETE_ENDINGS = ["step_cap", "context_window", "stopped_early"] as const;
export type IncompleteEnding = (typeof INCOMPLETE_ENDINGS)[number];

// Why every model a task could use refused it: a per-day limit, which a new
// run meets again until it resets, or a rate limit that outlasted the run's
// waits.
export const QUOTA_STOPS = ["daily_limit", "rate_limit"] as const;
export type QuotaStop = (typeof QUOTA_STOPS)[number];

// What one attempt of a review task looked at and answered: the files it
// read, the literals it searched for and its final text. Kept in the session
// log, never in the report, so an analysis can tell a file the reviewer never
// read from one it read and reported nothing on. The rest is what the run's
// trace shows of it (ADR-0081); absent from logs older than that.
export interface AttemptRecord {
  model: string;
  read: string[];
  searched: string[];
  text: string;
  // Model requests, one per agent step, the wrap-up turn's included.
  steps?: number;
  // Calls per tool, as the review tools name them.
  tools?: Record<string, number>;
  ending?: "done" | IncompleteEnding | "error";
  usage?: Usage;
  ms?: number;
}

export type AgentEvent =
  // attempt: on the line that sums up a finished attempt.
  | { type: "progress"; taskId: string; message: string; attempt?: AttemptRecord }
  // model: the one that reported the finding, when the runtime knows it.
  | { type: "finding"; taskId: string; finding: unknown; model?: string }
  | ({ type: "usage"; taskId: string } & Usage)
  // ended: absent when the agent called the done tool; otherwise how it
  // stopped without it, so its files count as only partly reviewed. wrapUp:
  // such an attempt was given one more turn to report what it had confirmed.
  // refusedFindings: per finding the runtime refused for its arguments and
  // the agent did not send again, the fields that failed.
  | {
      type: "done";
      taskId: string;
      ended?: IncompleteEnding;
      wrapUp?: { findings: number };
      refusedFindings?: string[];
    }
  // quota: every model of the task's chain is out of quota for this run.
  | { type: "error"; taskId: string; error: string; retryable: boolean; quota?: QuotaStop };

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cachedTokens: number;
  costUsd: number;
}

export interface CompletionRequest {
  tier: ModelTier;
  // The agent the call is made for: a reviewer id (its plan call), or a
  // role (AGENT_ROLES).
  agent?: string;
  effort?: Effort;
  // The agent's own failback chain; absent: the tier's.
  models?: readonly string[];
  system: string;
  user: string;
  // Set when a task of this agent follows under the same system prompt:
  // where in `user` the starts end that the task's prompt opens with too,
  // shortest first. A runtime whose provider stores prompts then sends the
  // request as it would that task's first, tools included, and stores those
  // starts for the task to read; the tools are offered, never run.
  sharedPrefixes?: readonly number[];
  timeoutMs: number;
}

export interface CompletionResult {
  text: string;
  usage: Usage;
  // The model that answered, when the runtime says.
  model?: string;
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
  // The coding agent that runs each review task, as people know it
  // ("Codex"); absent when ocra's own engine runs them.
  readonly agent?: string;
  // Absent: the runtime applies none of the requested sampling settings.
  readonly sampling?: AppliedSampling;
  // What the runtime applied for an agent that asked for an effort; undefined
  // when that agent made no such call. Absent: the runtime sends no effort.
  appliedTo?(agent: string): AppliedSettings | undefined;
  runTask(spec: AgentTaskSpec, signal: AbortSignal): AsyncIterable<AgentEvent>;
  // The runtime runs a task with AgentTaskSpec.toolset. Absent: it offers
  // every task the review's tools, so no task that needs others is given to it.
  readonly toolsets?: true;
  // Throws a CompletionError carrying the usage of failed attempts.
  complete?(request: CompletionRequest, signal: AbortSignal): Promise<CompletionResult>;
  dispose?(): Promise<void>;
}
