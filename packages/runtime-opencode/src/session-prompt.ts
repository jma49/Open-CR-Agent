import {
  type AttemptOutcome,
  emptyUsage,
  errorMessage,
  MAX_QUOTA_WAIT_MS,
  OcraError,
  parseModel,
  parseQuotaError,
  type QuotaError,
  type TaskAttempt,
  type Usage,
} from "@open-cr-agent/core";
import type { OpencodeClient } from "@opencode-ai/sdk/v2";
import {
  parseSessionMessages,
  readSession,
  type SessionMessage,
  sessionSteps,
  sessionUsage,
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
// OpenCode's step cap is a request to the model: on the last step it says to
// answer in text and still offers the tools, so a model that keeps calling
// them, or an endpoint whose answers OpenCode reads as empty, goes on until
// the task's timeout. A turn seen this far past its cap is stopped.
const STEP_OVERRUN = 2;

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
  // The steps the agent's configuration allows one turn.
  maxSteps: number;
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
  message: string;
}

// One prompt in a session: the agent (which sets the step cap) and variant
// it runs with, the tools it is offered, and what it is told.
interface Turn {
  agent: string;
  variant?: string;
  tools: Record<string, boolean>;
  maxSteps: number;
  message: string;
}

// About one review attempt in twelve on Gemini ended after a step or two
// with no text, no done tool and steps to spare (2026-09-28), and the task
// counted as completed with its files unread. Continuing the same session
// keeps what it read and is cheaper than starting over.
function stoppedEarly(outcome: AttemptOutcome, resume: ResumeOptions, maxSteps: number): boolean {
  return (
    !outcome.atStepCap &&
    !outcome.toolCalls.includes(resume.doneTool) &&
    outcome.steps < maxSteps &&
    outcome.text.trim() === ""
  );
}

// OpenCode caps each prompt's steps, so the cap ended an attempt when its
// last turn alone used them all.
function capped(
  outcome: AttemptOutcome,
  lastTurnSteps: number,
  resume: ResumeOptions,
  maxSteps: number,
) {
  const atCap =
    !outcome.error && !outcome.toolCalls.includes(resume.doneTool) && lastTurnSteps >= maxSteps;
  return atCap ? { ...outcome, atStepCap: true as const } : outcome;
}

type SessionApi = Pick<
  OpencodeClient["session"],
  "create" | "prompt" | "messages" | "abort" | "status"
>;

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
  const turn = (t: Turn, stepsBefore: number) => runTurn(opened, t, stepsBefore);
  const { maxSteps } = input;
  const review = {
    agent: input.agent,
    ...(input.variant ? { variant: input.variant } : {}),
    tools: input.tools,
    maxSteps,
  };
  let outcome = await turn({ ...review, message: input.user }, 0);
  let lastTurnFrom = 0;
  if (!outcome.error && input.resume && stoppedEarly(outcome, input.resume, maxSteps)) {
    lastTurnFrom = outcome.steps;
    // Both turns are in the session: their findings and their spend.
    outcome = {
      ...(await turn({ ...review, message: input.resume.message }, lastTurnFrom)),
      resumed: true,
    };
  }
  if (input.resume) {
    outcome = capped(outcome, outcome.steps - lastTurnFrom, input.resume, maxSteps);
  }
  const { wrapUp } = input;
  if (!wrapUp) return outcome;
  const { resumed, steps } = outcome;
  return {
    ...outcome,
    wrapUp: async () => ({ ...(await turn(wrapUp, steps)), ...(resumed ? { resumed } : {}) }),
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
// earlier turn included. stepsBefore: the session's steps when it starts.
async function runTurn(
  { session, sessionID, input, reportTool, signal, activity }: OpenSession,
  turn: Turn,
  stepsBefore: number,
): Promise<AttemptOutcome> {
  const stop = () => void session.abort({ sessionID }).catch(() => {});
  if (signal.aborted) {
    return {
      ...(await harvest(session, sessionID, reportTool, input.toolPrefix)),
      error: { message: "cancelled", retryable: false },
    };
  }
  signal.addEventListener("abort", stop, { once: true });
  const silence = watchActivity(session, sessionID, {
    ...activity,
    stepLimit: stepsBefore + turn.maxSteps + STEP_OVERRUN,
  });
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
    // The request was cut off, but OpenCode would keep running the session.
    if (silence.refused || silence.overran) stop();
    // The session ran even when the answer is an error, and it may have
    // spent tokens and reported findings: keep them.
    if (silence.overran) {
      return atStepCap(await harvest(session, sessionID, reportTool, input.toolPrefix));
    }
    if (response.error) {
      return {
        ...(await harvest(session, sessionID, reportTool, input.toolPrefix)),
        error: refusal(silence.refused) ?? {
          message: JSON.stringify(response.error),
          retryable: false,
        },
      };
    }
    try {
      const messages = await session.messages({ sessionID }, { signal: attempt });
      return readSession(messages.data, reportTool, input.toolPrefix);
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
    if (silence.overran && !signal.aborted) return atStepCap(partial);
    const seconds = Math.round((activity.inactivityMs ?? INACTIVITY_MS) / 1000);
    return {
      ...partial,
      error: signal.aborted
        ? { message: "cancelled", retryable: false }
        : (refusal(silence.refused) ??
          (silence.signal.aborted
            ? { message: `no activity for ${seconds}s`, retryable: true }
            : { message: errorMessage(error), retryable: true })),
    };
  } finally {
    silence.stop();
    signal.removeEventListener("abort", stop);
  }
}

// A turn stopped past its cap used its steps like one OpenCode ended at it;
// the session's error is only the stop.
function atStepCap({ error: _, ...outcome }: AttemptOutcome): AttemptOutcome {
  return { ...outcome, atStepCap: true };
}

type Refusal = { message: string; quota: QuotaError };

const refusal = (refused: Refusal | undefined) =>
  refused && { message: refused.message, retryable: true, quota: refused.quota };

// Aborts when the session's messages stop changing. A failed poll counts as
// no news, not as silence, so a slow server alone cannot end a task.
// Also aborts when OpenCode holds the session in a retry it was told to wait
// longer for than a run waits on a rate limit: it would sleep out a daily
// limit's wait until the task's timeout, where the model chain can stop at once.
// And when the session has more steps than `stepLimit`.
function watchActivity(
  session: SessionApi,
  sessionID: string,
  options: ActivityOptions & { stepLimit: number },
): ActivityWatch {
  const controller = new AbortController();
  const watch: ActivityWatch = {
    signal: controller.signal,
    stop: () => clearInterval(timer),
  };
  const inactivityMs = options.inactivityMs ?? INACTIVITY_MS;
  let last = "";
  let changedAt = Date.now();
  let polling = false;
  let reported = emptyUsage();
  const timer = setInterval(async () => {
    if (polling) return;
    polling = true;
    try {
      const refused = await longRetry(session, sessionID).catch(() => undefined);
      if (refused) {
        watch.refused = refused;
        controller.abort();
        return;
      }
      const messages = await session.messages(
        { sessionID },
        { signal: AbortSignal.timeout(HARVEST_TIMEOUT_MS) },
      );
      const list = parseSessionMessages(messages.data).messages;
      if (sessionSteps(list) > options.stepLimit) {
        watch.overran = true;
        controller.abort();
        return;
      }
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
  return watch;
}

interface ActivityWatch {
  signal: AbortSignal;
  refused?: Refusal;
  overran?: true;
  stop(): void;
}

async function longRetry(session: SessionApi, sessionID: string): Promise<Refusal | undefined> {
  const statuses = await session.status({}, { signal: AbortSignal.timeout(HARVEST_TIMEOUT_MS) });
  const status = statuses.data?.[sessionID];
  if (status?.type !== "retry") return undefined;
  const retryAfterMs = Math.max(0, status.next - Date.now());
  if (retryAfterMs <= MAX_QUOTA_WAIT_MS) return undefined;
  const quota = parseQuotaError(status.message, 429) ?? { daily: false };
  return { message: status.message, quota: { ...quota, retryAfterMs } };
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
    return readSession(messages.data, reportTool, toolPrefix);
  } catch {
    return emptyOutcome();
  }
}

function emptyOutcome(): AttemptOutcome {
  return { findings: [], steps: 0, toolCalls: [], text: "", usage: emptyUsage() };
}
