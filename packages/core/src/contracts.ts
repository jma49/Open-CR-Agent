import type { ChangeRequest, FileDiff, PriorReview, ReviewResult } from "./domain.js";

export interface CodeMatch {
  path: string;
  line: number;
  text: string;
}

export interface VcsAdapter {
  readonly name: string;
  getChangeRequest(): Promise<ChangeRequest>;
  getDiff(): Promise<FileDiff[]>;
  readFile(path: string): Promise<string | undefined>;
  searchCode(literal: string): Promise<CodeMatch[]>;
  getPriorReview(): Promise<PriorReview | undefined>;
  publish(result: ReviewResult): Promise<void>;
}

export type ModelTier = "top" | "standard" | "light";

export interface AgentTaskSpec {
  taskId: string;
  reviewer: string;
  modelTier: ModelTier;
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

export type AgentEvent =
  | { type: "progress"; taskId: string; message: string }
  | { type: "finding"; taskId: string; finding: unknown }
  | ({ type: "usage"; taskId: string } & Usage)
  | { type: "done"; taskId: string }
  | { type: "error"; taskId: string; error: string; retryable: boolean };

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cachedTokens: number;
  costUsd: number;
}

export interface AgentRuntime {
  readonly name: string;
  runTask(spec: AgentTaskSpec, signal: AbortSignal): AsyncIterable<AgentEvent>;
  dispose?(): Promise<void>;
}
