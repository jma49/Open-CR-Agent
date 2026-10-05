import {
  type AttemptOutcome,
  emptyUsage,
  errorMessage,
  OcraError,
  parseModel,
  type TaskAttempt,
  type Usage,
} from "@open-cr-agent/core";
import type { OpencodeClient } from "@opencode-ai/sdk/v2";
import {
  parseSessionMessages,
  type SessionMessage,
  sessionUsage,
  summarizeSession,
} from "./session-outcome.js";

// A session that was cut off has still spent tokens and may have reported
// findings; this bounds the one extra request that collects them.
const HARVEST_TIMEOUT_MS = 5_000;

// A prompt returns only when the agent is done, so silence on the request is
// normal; silence in the session is not. A session whose messages have not
// changed for this long (no new step, no streamed text, no tool progress) is
// stopped and the task moves to the next model instead of waiting for its
// full timeout. Generous, so a slow step that is still writing survives.
const INACTIVITY_MS = 5 * 60_000;
// Each poll also reports what the session has spent, and a run's spend limit
// stops running tasks on those reports: this bounds how far past the limit a
// task can get before it is stopped.
const ACTIVITY_POLL_MS = 10_000;

export interface ActivityOptions {
  inactivityMs?: number;
  pollMs?: number;
  // What the session has spent so far, whenever a poll sees it grow.
  onUsage?: (spent: Usage) => void;
}

export interface PromptInput {
  title: string;
  agent: string;
  model: string;
  // The OpenCode variant that carries the agent's effort (effort.ts).
  variant?: string;
  system: string;
  user: string;
  tools: Record<string, boolean>;
  // What OpenCode prefixes the review tools' names with (the MCP server).
  toolPrefix?: string;
  // Review agents only: when the agent stops early (no done tool, no answer,
  // steps left), the same session is told once to finish.
  resume?: ResumeOptions;
  // Review agents only: the turn the attempt offers as TaskAttempt.wrapUp,
  // in the same session.
  wrapUp?: Turn;
}

interface ResumeOptions {
  doneTool: string;
  maxSteps: number;
  message: string;
}

// One prompt in a session: the agent (which sets the step cap) and variant
// it runs with, the tools it is offered, and what it is told.
interface Turn {
  agent: string;
  variant?: string;
  tools: Record<string, boolean>;
  message: string;
}

// About one review attempt in twelve on Gemini ended after a step or two
// with no text, no done tool and steps to spare (2026-09-28), and the task
// counted as completed with its files unread. Continuing the same session
// keeps what it read and is cheaper than starting over.
function stoppedEarly(outcome: AttemptOutcome, resume: ResumeOptions): boolean {
  return (
    !outcome.toolCalls.includes(resume.doneTool) &&
    outcome.steps < resume.maxSteps &&
    outcome.text.trim() === ""
  );
}

// OpenCode caps each prompt's steps, so the cap ended an attempt when its
// last turn alone used them all.
function capped(outcome: AttemptOutcome, lastTurnSteps: number, resume: ResumeOptions) {
  const atCap =
    !outcome.error &&
    !outcome.toolCalls.includes(resume.doneTool) &&
    lastTurnSteps >= resume.maxSteps;
  return atCap ? { ...outcome, atStepCap: true as const } : outcome;
}

type SessionApi = Pick<OpencodeClient["session"], "create" | "prompt" | "messages" | "abort">;

export async function promptSession(
  session: SessionApi,
  input: PromptInput,
  reportTool: string,
  signal: AbortSignal,
  activity: ActivityOptions = {},
): Promise<TaskAttempt> {
  const created = await session.create({ title: input.title }, { signal });
  if (!created.data) {
    throw new OcraError(
      "RUNTIME_FAILED",
      `OpenCode could not create a session: ${JSON.stringify(created.error)}`,
    );
  }
  const opened: OpenSession = {
    session,
    sessionID: created.data.id,
    input,
    reportTool,
    signal,
    activity,
  };
  const turn = (t: Turn) => runTurn(opened, t);
  const review = {
    agent: input.agent,
    ...(input.variant ? { variant: input.variant } : {}),
    tools: input.tools,
  };
  let outcome = await turn({ ...review, message: input.user });
  let lastTurnFrom = 0;
  if (!outcome.error && input.resume && stoppedEarly(outcome, input.resume)) {
    lastTurnFrom = outcome.steps;
    // Both turns are in the session: their findings and their spend.
    outcome = { ...(await turn({ ...review, message: input.resume.message })), resumed: true };
  }
  if (input.resume) outcome = capped(outcome, outcome.steps - lastTurnFrom, input.resume);
  const { wrapUp } = input;
  if (!wrapUp) return outcome;
  const resumed = outcome.resumed;
  return {
    ...outcome,
    wrapUp: async () => ({ ...(await turn(wrapUp)), ...(resumed ? { resumed } : {}) }),
  };
}

interface OpenSession {
  session: SessionApi;
  sessionID: string;
  input: PromptInput;
  reportTool: string;
  signal: AbortSignal;
  activity: ActivityOptions;
}

// Sends one turn and returns what the whole session has come to, every
// earlier turn included.
async function runTurn(
  { session, sessionID, input, reportTool, signal, activity }: OpenSession,
  turn: Turn,
): Promise<AttemptOutcome> {
  const stop = () => void session.abort({ sessionID }).catch(() => {});
  if (signal.aborted) {
    return {
      ...(await harvest(session, sessionID, reportTool, input.toolPrefix)),
      error: { message: "cancelled", retryable: false },
    };
  }
  signal.addEventListener("abort", stop, { once: true });
  const silence = watchActivity(session, sessionID, activity);
  const attempt = AbortSignal.any([signal, silence.signal]);
  try {
    const response = await session.prompt(
      {
        sessionID,
        agent: turn.agent,
        model: parseModel(input.model),
        ...(turn.variant ? { variant: turn.variant } : {}),
        system: input.system,
        tools: turn.tools,
        parts: [{ type: "text", text: turn.message }],
      },
      { signal: attempt },
    );
    // The session ran even when the answer is an error, and it may have
    // spent tokens and reported findings: keep them.
    if (response.error) {
      return {
        ...(await harvest(session, sessionID, reportTool, input.toolPrefix)),
        error: { message: JSON.stringify(response.error), retryable: false },
      };
    }
    try {
      const messages = await session.messages({ sessionID }, { signal: attempt });
      return summarizeSession(parseSessionMessages(messages.data), reportTool, input.toolPrefix);
    } catch (error) {
      // The session finished; running it again on the next model would pay
      // twice. Keep what one more read gets, and do not retry.
      return {
        ...(await harvest(session, sessionID, reportTool, input.toolPrefix)),
        error: {
          message: `could not read the finished session: ${errorMessage(error)}`,
          retryable: false,
        },
      };
    }
  } catch (error) {
    // Aborted or cut off by the transport: OpenCode may still be running the
    // session, spending tokens, so stop it and keep what it already did.
    stop();
    const partial = await harvest(session, sessionID, reportTool, input.toolPrefix);
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
  let reported = emptyUsage();
  const timer = setInterval(async () => {
    if (polling) return;
    polling = true;
    try {
      const messages = await session.messages(
        { sessionID },
        { signal: AbortSignal.timeout(HARVEST_TIMEOUT_MS) },
      );
      const list = parseSessionMessages(messages.data);
      if (options.onUsage) {
        const spent = sessionUsage(list);
        if (spent.costUsd > reported.costUsd || spent.inputTokens > reported.inputTokens) {
          reported = spent;
          options.onUsage(spent);
        }
      }
      const now = activitySignature(list);
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
function activitySignature(messages: readonly SessionMessage[]): string {
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
  toolPrefix?: string,
): Promise<AttemptOutcome> {
  try {
    const messages = await session.messages(
      { sessionID },
      { signal: AbortSignal.timeout(HARVEST_TIMEOUT_MS) },
    );
    return summarizeSession(parseSessionMessages(messages.data), reportTool, toolPrefix);
  } catch {
    return emptyOutcome();
  }
}

function emptyOutcome(): AttemptOutcome {
  return { findings: [], steps: 0, toolCalls: [], text: "", usage: emptyUsage() };
}
