import type { Usage } from "@open-cr-agent/core";

export interface SessionMessage {
  info: {
    role: string;
    cost?: number;
    tokens?: { input?: number; output?: number; reasoning?: number; cache?: { read?: number } };
    error?: {
      name?: string;
      data?: { message?: string; statusCode?: number; isRetryable?: boolean };
    };
  };
  parts: {
    type: string;
    text?: string;
    tool?: string;
    state?: { status?: string; input?: unknown };
  }[];
}

export interface SessionOutcome {
  findings: unknown[];
  toolCalls: string[];
  text: string;
  usage: Usage;
  error?: { message: string; retryable: boolean };
}

const AUTH_STATUS = new Set([401, 403]);
const AUTH_MESSAGE = /api key|unauthori[sz]ed|permission denied|forbidden/i;

export function summarizeSession(
  messages: readonly SessionMessage[],
  reportTool: string,
): SessionOutcome {
  const assistant = messages.filter((m) => m.info.role === "assistant");
  const tools = assistant.flatMap((m) => m.parts.filter((p) => p.type === "tool"));
  const outcome: SessionOutcome = {
    findings: tools
      .filter((p) => p.tool === reportTool && p.state?.status === "completed")
      .map((p) => p.state?.input),
    toolCalls: tools.map((p) => p.tool ?? "unknown"),
    text: assistant
      .flatMap((m) => m.parts.filter((p) => p.type === "text").map((p) => p.text ?? ""))
      .join("\n")
      .trim(),
    usage: {
      inputTokens: sum(assistant, (m) => m.info.tokens?.input),
      outputTokens: sum(assistant, (m) => m.info.tokens?.output),
      reasoningTokens: sum(assistant, (m) => m.info.tokens?.reasoning),
      cachedTokens: sum(assistant, (m) => m.info.tokens?.cache?.read),
      costUsd: sum(assistant, (m) => m.info.cost),
    },
  };

  const errors = assistant.flatMap((m) => (m.info.error ? [m.info.error] : []));
  const last = errors.at(-1);
  if (last) {
    // Overloads and model-specific request rejections (for example Gemini 3.8
    // refusing a request that ends with a model turn) are fixed by another
    // model; only credential problems would fail on every model.
    outcome.error = {
      message: last.data?.message ?? last.name ?? "unknown model error",
      retryable: !errors.some(isAuthError),
    };
  }
  return outcome;
}

function isAuthError(error: NonNullable<SessionMessage["info"]["error"]>): boolean {
  return (
    error.name === "ProviderAuthError" ||
    AUTH_STATUS.has(error.data?.statusCode ?? 0) ||
    AUTH_MESSAGE.test(error.data?.message ?? "")
  );
}

function sum(
  messages: readonly SessionMessage[],
  pick: (m: SessionMessage) => number | undefined,
): number {
  return messages.reduce((total, m) => total + (pick(m) ?? 0), 0);
}
