import { addUsage, emptyUsage } from "../agent/usage.js";
import type { AgentEvent, CompletionResult, ModelTier, Usage } from "../contracts.js";
import { type CallFailure, CompletionError } from "../errors.js";
import {
  type AttemptEnding,
  type AttemptOutcome,
  attemptEnding,
  attemptRecord,
  attemptSummary,
  type TaskAttempt,
} from "./attempt.js";
import type { ModelHealth } from "./models.js";
import { type QuotaError, sleep } from "./quota.js";
import { outcomeOf, pendingWrapUp, wrapUp } from "./wrap-up.js";

export interface FailbackOptions {
  taskId: string;
  tier: ModelTier;
  // Set when the chain is this agent's own rather than the tier's.
  agent?: string;
  chain: readonly string[];
  health: ModelHealth;
  signal: AbortSignal;
  // onUsage receives what the attempt has spent so far, as it grows.
  attempt(model: string, onUsage: (spent: Usage) => void, limits: RateLimits): Promise<TaskAttempt>;
}

// What an attempt that can send a request again does with a rate limit
// instead of ending: the steps it has taken are not asked and paid for twice.
export interface RateLimits {
  // Resolves true once the model's pause, shared by every task, is over and
  // the refused request may be sent again; false when the model is out of
  // quota for this run or the task was stopped, and the attempt ends with
  // the refusal.
  waitOut(quota: QuotaError): Promise<boolean>;
}

// Findings from a failed attempt are still emitted: the pipeline deduplicates
// by fingerprint, so a retry on the next model cannot double-report them.
export async function* withFailback(options: FailbackOptions): AsyncGenerator<AgentEvent> {
  const { taskId, health, signal } = options;
  let lastError = "";
  for (const model of health.order(options.chain)) {
    for (;;) {
      if (signal.aborted) return;
      const pause = health.pausedFor(model);
      if (pause > 0) {
        yield { type: "progress", taskId, message: rateLimited(model, pause) };
        await pauseOver(health, model, signal);
        if (signal.aborted) return;
      }
      // Another task may have found it out of quota since the chain was read.
      if (health.isOutOfQuota(model)) break;
      yield { type: "progress", taskId, message: `reviewing with ${model}` };
      // Spend is reported while the attempt runs, so a run's spend limit
      // can stop it; the finished attempt's total settles the rest.
      const live = new LiveUsage();
      const started = performance.now();
      const attempt = yield* whileRunning(
        taskId,
        live,
        options.attempt(model, (spent) => live.observe(spent), {
          waitOut: async (quota) => {
            if (health.recordQuota(model, quota) !== "wait") return false;
            live.note(rateLimited(model, health.pausedFor(model)));
            await pauseOver(health, model, signal);
            return !signal.aborted && !health.isOutOfQuota(model);
          },
        }),
      );
      yield { type: "usage", taskId, ...live.rest(attempt.usage) };
      let outcome = outcomeOf(attempt);
      // Read before the wrap-up turn, whose done tool reports what the agent
      // had confirmed and reads nothing more: its files stay partly reviewed.
      const ended = attemptEnding(outcome);
      // Decided after the attempt's spend was handed over, so a spend limit
      // it reached has already aborted the signal.
      const turn = pendingWrapUp(attempt, ended, signal);
      if (turn) {
        outcome = yield* whileRunning(taskId, live, wrapUp(outcome, turn));
        yield { type: "usage", taskId, ...live.rest(outcome.usage) };
      }
      yield {
        type: "progress",
        taskId,
        message: attemptSummary(model, outcome),
        attempt: attemptRecord(model, outcome, {
          ending: ended,
          ms: Math.round(performance.now() - started),
        }),
      };
      for (const finding of outcome.findings) yield { type: "finding", taskId, finding, model };

      // Ended without an error, the attempt finished even if the task was
      // stopped meanwhile, as when the spend its last report added reached
      // the run's limit: the pipeline decides what that stop means.
      if (!outcome.error) {
        health.recordSuccess(model);
        yield doneEvent(taskId, ended, outcome);
        return;
      }
      // A cancelled attempt is neither finished nor the model's fault.
      if (signal.aborted) return;
      if (!outcome.error.retryable) {
        yield {
          type: "error",
          taskId,
          error: `${model}: ${outcome.error.message}`,
          retryable: false,
        };
        return;
      }
      if (outcome.error.quota && health.recordQuota(model, outcome.error.quota) === "wait") {
        continue;
      }
      if (!outcome.error.quota) health.recordFailure(model);
      lastError = `${model}: ${outcome.error.message}`;
      yield { type: "progress", taskId, message: `${lastError}; trying the next model` };
      break;
    }
  }
  const quota = health.quotaStop(options.chain);
  yield {
    type: "error",
    taskId,
    error: lastError
      ? `every ${chainName(options)} failed (${lastError})`
      : `every ${chainName(options)} is out of quota for this run`,
    retryable: true,
    ...(quota ? { quota } : {}),
  };
}

function doneEvent(
  taskId: string,
  ended: AttemptEnding,
  { wrappedUp, refusedFindings }: AttemptOutcome,
): AgentEvent {
  return {
    type: "done",
    taskId,
    ...(ended === "done" || ended === "error" ? {} : { ended }),
    ...(wrappedUp ? { wrapUp: { findings: wrappedUp.findings } } : {}),
    ...(refusedFindings?.length ? { refusedFindings } : {}),
  };
}

function rateLimited(model: string, pauseMs: number): string {
  return `${model} is rate limited; waiting ${Math.ceil(pauseMs / 1000)}s`;
}

// Yields the spend that grows and the notes left while `running` runs, then
// returns its result.
async function* whileRunning<T>(
  taskId: string,
  live: LiveUsage,
  running: Promise<T>,
): AsyncGenerator<AgentEvent, T> {
  const finished = running.then(
    () => false,
    () => false,
  );
  while (await Promise.race([finished, live.changed().then(() => true)])) {
    for (const message of live.notes()) yield { type: "progress", taskId, message };
    if (live.spentMore()) yield { type: "usage", taskId, ...live.take() };
  }
  return await running;
}

// Hands out what an attempt has spent in increments, each what grew since the
// last one; `rest` settles the finished attempt's total, so the increments
// add up to it and nothing is counted twice. Also what the attempt has to
// say while it runs.
class LiveUsage {
  private seen = emptyUsage();
  private given = emptyUsage();
  private said: string[] = [];
  private wake: (() => void) | undefined;

  observe(spent: Usage): void {
    this.seen = larger(this.seen, spent);
    if (this.spentMore()) this.woken();
  }

  note(message: string): void {
    this.said.push(message);
    this.woken();
  }

  notes(): string[] {
    return this.said.splice(0);
  }

  spentMore(): boolean {
    return ahead(this.seen, this.given);
  }

  // Resolves once there is a note, or more has been seen than handed out.
  changed(): Promise<void> {
    if (this.said.length > 0 || this.spentMore()) return Promise.resolve();
    return new Promise((resolve) => {
      this.wake = resolve;
    });
  }

  private woken(): void {
    this.wake?.();
    this.wake = undefined;
  }

  take(): Usage {
    const increment = beyond(this.seen, this.given);
    this.given = this.seen;
    return increment;
  }

  rest(total: Usage): Usage {
    const settled = larger(total, this.given);
    const increment = beyond(settled, this.given);
    this.given = settled;
    return increment;
  }
}

const FIELDS = [
  "inputTokens",
  "outputTokens",
  "reasoningTokens",
  "cachedTokens",
  "costUsd",
] as const satisfies readonly (keyof Usage)[];

// Each field of a usage from the same field of two others.
function mapUsage(a: Usage, b: Usage, combine: (x: number, y: number) => number): Usage {
  return {
    inputTokens: combine(a.inputTokens, b.inputTokens),
    outputTokens: combine(a.outputTokens, b.outputTokens),
    reasoningTokens: combine(a.reasoningTokens, b.reasoningTokens),
    cachedTokens: combine(a.cachedTokens, b.cachedTokens),
    costUsd: combine(a.costUsd, b.costUsd),
  };
}

function larger(a: Usage, b: Usage): Usage {
  return mapUsage(a, b, Math.max);
}

function beyond(a: Usage, b: Usage): Usage {
  return mapUsage(a, b, (x, y) => Math.max(0, x - y));
}

function ahead(a: Usage, b: Usage): boolean {
  return FIELDS.some((f) => a[f] > b[f]);
}

export interface CompleteOptions {
  tier: ModelTier;
  agent?: string;
  chain: readonly string[];
  health: ModelHealth;
  signal: AbortSignal;
  attempt(model: string): Promise<AttemptOutcome>;
}

// One answer from the first model of the chain that gives one, with the same
// quota waits and circuit breaker as a task; throws a CompletionError that
// carries what the failed attempts spent.
export async function completeWithFailback(options: CompleteOptions): Promise<CompletionResult> {
  const { health, signal } = options;
  let usage = emptyUsage();
  let lastError = "";
  let failure: CallFailure = "unavailable";
  for (const model of health.order(options.chain)) {
    for (;;) {
      await pauseOver(health, model, signal);
      if (signal.aborted) throw new CompletionError("cancelled", usage);
      if (health.isOutOfQuota(model)) break;
      const outcome = await options.attempt(model);
      usage = addUsage(usage, outcome.usage);
      if (!outcome.error) {
        health.recordSuccess(model);
        return { text: outcome.text, usage, model };
      }
      if (!outcome.error.retryable) {
        throw new CompletionError(`${model}: ${outcome.error.message}`, usage, {
          failure: "refused",
        });
      }
      if (outcome.error.quota && health.recordQuota(model, outcome.error.quota) === "wait") {
        continue;
      }
      if (!outcome.error.quota) health.recordFailure(model);
      failure = outcome.error.quota ? "quota" : "unavailable";
      lastError = `${model}: ${outcome.error.message}`;
      break;
    }
  }
  if (!lastError) {
    throw new CompletionError(`every ${chainName(options)} is out of quota for this run`, usage, {
      failure: "quota",
    });
  }
  throw new CompletionError(`every ${chainName(options)} failed (${lastError})`, usage, {
    failure,
  });
}

// Waits until the model's pause ends as it stands on waking, not as it stood
// on falling asleep: another task's limit may have lengthened it, and a
// request sent inside it would only join it again.
async function pauseOver(health: ModelHealth, model: string, signal: AbortSignal): Promise<void> {
  for (;;) {
    const pause = health.pausedFor(model);
    if (pause <= 0 || signal.aborted || health.isOutOfQuota(model)) return;
    await sleep(pause, signal);
  }
}

function chainName(options: { tier: ModelTier; agent?: string }): string {
  return options.agent === undefined
    ? `${options.tier} model`
    : `model of ${options.agent}'s own chain`;
}
