import type {
  ChangeRequest,
  FileDiff,
  PriorReview,
  ReportedFinding,
  ReviewResult,
} from "./domain.js";

export interface VcsAdapter {
  readonly name: string;
  getChangeRequest(): Promise<ChangeRequest>;
  getDiff(): Promise<FileDiff[]>;
  readFile(path: string): Promise<string | undefined>;
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
  workingDirectory: string;
  timeoutMs: number;
}

export type AgentEvent =
  | { type: "progress"; taskId: string; message: string }
  | { type: "finding"; taskId: string; finding: ReportedFinding }
  | {
      type: "usage";
      taskId: string;
      inputTokens: number;
      outputTokens: number;
      cachedTokens: number;
    }
  | { type: "done"; taskId: string }
  | { type: "error"; taskId: string; error: string; retryable: boolean };

export interface AgentRuntime {
  readonly name: string;
  runTask(spec: AgentTaskSpec, signal: AbortSignal): AsyncIterable<AgentEvent>;
}
