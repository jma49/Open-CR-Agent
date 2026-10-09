import { type AttemptOutcome, exploredBy, parseQuotaError, type Usage } from "@open-cr-agent/core";
import { z } from "zod";

// The part of OpenCode's session messages ocra reads, validated rather than
// cast: the SDK's types are not checked at runtime, and a server of another
// version could answer in another shape. Unknown fields are dropped.
const sessionMessageSchema = z.object({
  info: z.object({
    role: z.string(),
    cost: z.number().optional(),
    tokens: z
      .object({
        input: z.number().optional(),
        output: z.number().optional(),
        reasoning: z.number().optional(),
        cache: z.object({ read: z.number().optional() }).optional(),
      })
      .optional(),
    error: z
      .object({
        name: z.string().optional(),
        data: z
          .object({
            message: z.string().optional(),
            statusCode: z.number().optional(),
            isRetryable: z.boolean().optional(),
          })
          .optional(),
      })
      .optional(),
  }),
  parts: z.array(
    z.object({
      type: z.string(),
      text: z.string().optional(),
      tool: z.string().optional(),
      state: z.object({ status: z.string().optional(), input: z.unknown().optional() }).optional(),
    }),
  ),
});

export type SessionMessage = z.output<typeof sessionMessageSchema>;

// The messages ocra can read, and how many it could not: one message in an
// unexpected shape must not cost the attempt its findings and usage. Throws
// when the answer is not a list.
export function parseSessionMessages(data: unknown): {
  messages: SessionMessage[];
  unread: number;
} {
  const messages: SessionMessage[] = [];
  let unread = 0;
  for (const raw of z.array(z.unknown()).parse(data ?? [])) {
    const parsed = sessionMessageSchema.safeParse(raw);
    if (parsed.success) messages.push(parsed.data);
    else unread += 1;
  }
  return { messages, unread };
}

// The attempt as the session's messages tell it, with the count of those
// that could not be read.
export function readSession(data: unknown, reportTool: string, toolPrefix = ""): AttemptOutcome {
  const { messages, unread } = parseSessionMessages(data);
  const outcome = summarizeSession(messages, reportTool, toolPrefix);
  return unread > 0 ? { ...outcome, unreadMessages: unread } : outcome;
}

const AUTH_STATUS = new Set([401, 403]);
const AUTH_MESSAGE = /api key|unauthori[sz]ed|permission denied|forbidden/i;

// Tool names come back with the MCP server's prefix (MCP_SERVER in
// runtime.ts), which the shared outcome does without.
export function summarizeSession(
  messages: readonly SessionMessage[],
  reportTool: string,
  toolPrefix = "",
): AttemptOutcome {
  const assistant = messages.filter((m) => m.info.role === "assistant");
  const tools = assistant.flatMap((m) => m.parts.filter((p) => p.type === "tool"));
  const names = tools.map((p) => (p.tool ?? "unknown").replace(toolPrefix, ""));
  const outcome: AttemptOutcome = {
    findings: tools
      .filter((p) => p.tool === reportTool && p.state?.status === "completed")
      .map((p) => p.state?.input),
    steps: assistant.reduce((n, m) => n + m.parts.filter((p) => p.type === "step-start").length, 0),
    toolCalls: names,
    // A call that did not complete never showed the reviewer anything.
    ...exploredBy(
      tools.flatMap((p, i) =>
        p.state?.status === "completed"
          ? [{ name: names[i] ?? "unknown", input: p.state.input }]
          : [],
      ),
    ),
    text: assistant
      .flatMap((m) => m.parts.filter((p) => p.type === "text").map((p) => p.text ?? ""))
      .join("\n")
      .trim(),
    usage: sessionUsage(messages),
  };

  const errors = assistant.flatMap((m) => (m.info.error ? [m.info.error] : []));
  const last = errors.at(-1);
  if (last) {
    // Overloads and model-specific request rejections (for example Gemini 3.8
    // refusing a request that ends with a model turn) are fixed by another
    // model; only credential problems would fail on every model.
    const message = last.data?.message ?? last.name ?? "unknown model error";
    outcome.error = { message, retryable: !errors.some(isAuthError) };
    const quota = parseQuotaError(message, last.data?.statusCode);
    if (quota) outcome.error.quota = quota;
  }
  return outcome;
}

// Every finished step carries its tokens and cost, so this grows while the
// session runs.
export function sessionUsage(messages: readonly SessionMessage[]): Usage {
  const assistant = messages.filter((m) => m.info.role === "assistant");
  return {
    inputTokens: sum(assistant, (m) => m.info.tokens?.input),
    outputTokens: sum(assistant, (m) => m.info.tokens?.output),
    reasoningTokens: sum(assistant, (m) => m.info.tokens?.reasoning),
    cachedTokens: sum(assistant, (m) => m.info.tokens?.cache?.read),
    costUsd: sum(assistant, (m) => m.info.cost),
  };
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
