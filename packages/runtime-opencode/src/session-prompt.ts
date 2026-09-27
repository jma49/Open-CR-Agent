import { emptyUsage, errorMessage } from "@open-cr-agent/core";
import type { OpencodeClient } from "@opencode-ai/sdk/v2";
import { parseModel } from "./models.js";
import { type SessionMessage, type SessionOutcome, summarizeSession } from "./session-outcome.js";

// A session that was cut off has still spent tokens and may have reported
// findings; this bounds the one extra request that collects them.
export const HARVEST_TIMEOUT_MS = 5_000;

export interface PromptInput {
  title: string;
  agent: string;
  model: string;
  system: string;
  user: string;
  tools: Record<string, boolean>;
}

type SessionApi = Pick<OpencodeClient["session"], "create" | "prompt" | "messages" | "abort">;

export async function promptSession(
  session: SessionApi,
  input: PromptInput,
  reportTool: string,
  signal: AbortSignal,
): Promise<SessionOutcome> {
  const created = await session.create({ title: input.title }, { signal });
  if (!created.data) {
    throw new Error(`OpenCode could not create a session: ${JSON.stringify(created.error)}`);
  }
  const sessionID = created.data.id;
  const stop = () => void session.abort({ sessionID }).catch(() => {});
  signal.addEventListener("abort", stop, { once: true });
  try {
    const response = await session.prompt(
      {
        sessionID,
        agent: input.agent,
        model: parseModel(input.model),
        system: input.system,
        tools: input.tools,
        parts: [{ type: "text", text: input.user }],
      },
      { signal },
    );
    if (response.error) {
      return {
        ...emptyOutcome(),
        error: { message: JSON.stringify(response.error), retryable: false },
      };
    }
    const messages = await session.messages({ sessionID }, { signal });
    return summarizeSession((messages.data ?? []) as SessionMessage[], reportTool);
  } catch (error) {
    // Aborted or cut off by the transport: OpenCode may still be running the
    // session, spending tokens, so stop it and keep what it already did.
    stop();
    const partial = await harvest(session, sessionID, reportTool);
    return {
      ...partial,
      error: signal.aborted
        ? { message: "cancelled", retryable: false }
        : { message: errorMessage(error), retryable: true },
    };
  } finally {
    signal.removeEventListener("abort", stop);
  }
}

async function harvest(
  session: SessionApi,
  sessionID: string,
  reportTool: string,
): Promise<SessionOutcome> {
  try {
    const messages = await session.messages(
      { sessionID },
      { signal: AbortSignal.timeout(HARVEST_TIMEOUT_MS) },
    );
    return summarizeSession((messages.data ?? []) as SessionMessage[], reportTool);
  } catch {
    return emptyOutcome();
  }
}

export function emptyOutcome(): SessionOutcome {
  return { findings: [], toolCalls: [], text: "", usage: emptyUsage() };
}
