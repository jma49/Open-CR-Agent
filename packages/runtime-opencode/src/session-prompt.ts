import { emptyUsage, errorMessage } from "@open-cr-agent/core";
import type { OpencodeClient } from "@opencode-ai/sdk/v2";
import { parseModel } from "./models.js";
import { type SessionMessage, type SessionOutcome, summarizeSession } from "./session-outcome.js";

// A session that was cut off has still spent tokens and may have reported
// findings; this bounds the one extra request that collects them.
export const HARVEST_TIMEOUT_MS = 5_000;

// A prompt returns only when the agent is done, so silence on the request is
// normal; silence in the session is not. A session whose messages have not
// changed for this long (no new step, no streamed text, no tool progress) is
// stopped and the task moves to the next model instead of waiting for its
// full timeout. Generous, so a slow step that is still writing survives.
export const INACTIVITY_MS = 5 * 60_000;
export const ACTIVITY_POLL_MS = 30_000;

export interface ActivityOptions {
  inactivityMs?: number;
  pollMs?: number;
}

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
  activity: ActivityOptions = {},
): Promise<SessionOutcome> {
  const created = await session.create({ title: input.title }, { signal });
  if (!created.data) {
    throw new Error(`OpenCode could not create a session: ${JSON.stringify(created.error)}`);
  }
  const sessionID = created.data.id;
  const stop = () => void session.abort({ sessionID }).catch(() => {});
  signal.addEventListener("abort", stop, { once: true });
  const silence = watchActivity(session, sessionID, activity);
  const attempt = AbortSignal.any([signal, silence.signal]);
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
      { signal: attempt },
    );
    if (response.error) {
      return {
        ...emptyOutcome(),
        error: { message: JSON.stringify(response.error), retryable: false },
      };
    }
    const messages = await session.messages({ sessionID }, { signal: attempt });
    return summarizeSession((messages.data ?? []) as SessionMessage[], reportTool);
  } catch (error) {
    // Aborted or cut off by the transport: OpenCode may still be running the
    // session, spending tokens, so stop it and keep what it already did.
    stop();
    const partial = await harvest(session, sessionID, reportTool);
    const seconds = Math.round((activity.inactivityMs ?? INACTIVITY_MS) / 1000);
    return {
      ...partial,
      error: signal.aborted
        ? { message: "cancelled", retryable: false }
        : silence.signal.aborted
          ? { message: `no activity for ${seconds}s`, retryable: true }
          : { message: errorMessage(error), retryable: true },
    };
  } finally {
    silence.stop();
    signal.removeEventListener("abort", stop);
  }
}

// Aborts when the session's messages stop changing. A failed poll counts as
// no news, not as silence, so a slow server alone cannot end a task.
function watchActivity(
  session: SessionApi,
  sessionID: string,
  options: ActivityOptions,
): { signal: AbortSignal; stop(): void } {
  const controller = new AbortController();
  const inactivityMs = options.inactivityMs ?? INACTIVITY_MS;
  let last = "";
  let changedAt = Date.now();
  let polling = false;
  const timer = setInterval(async () => {
    if (polling) return;
    polling = true;
    try {
      const messages = await session.messages(
        { sessionID },
        { signal: AbortSignal.timeout(HARVEST_TIMEOUT_MS) },
      );
      const now = activitySignature((messages.data ?? []) as SessionMessage[]);
      if (now !== last) {
        last = now;
        changedAt = Date.now();
      } else if (Date.now() - changedAt >= inactivityMs) {
        controller.abort();
      }
    } catch {
      // no news
    } finally {
      polling = false;
    }
  }, options.pollMs ?? ACTIVITY_POLL_MS);
  timer.unref?.();
  return { signal: controller.signal, stop: () => clearInterval(timer) };
}

// What changes while an agent works: steps, parts, streamed text, tool states.
export function activitySignature(messages: readonly SessionMessage[]): string {
  return messages
    .map((m) =>
      m.parts.map((p) => `${p.type}:${p.state?.status ?? ""}:${p.text?.length ?? 0}`).join(","),
    )
    .join("|");
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
