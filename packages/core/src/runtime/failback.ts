import { addUsage, emptyUsage } from "../agent/usage.js";
import type { AgentEvent, CompletionResult, ModelTier, Usage } from "../contracts.js";
import { CompletionError } from "../errors.js";
import { type AttemptOutcome, attemptSummary } from "./attempt.js";
import type { ModelHealth } from "./models.js";
import { sleep } from "./quota.js";

export interface FailbackOptions {
  taskId: string;
  tier: ModelTier;
  // Set when the chain is this agent's own rather than the tier's.
  agent?: string;
  chain: readonly string[];
  health: ModelHealth;
  signal: AbortSignal;
  // onUsage receives what the attempt has spent so far, as it grows.
  attempt(model: string, onUsage: (spent: Usage) => void): Promise<AttemptOutcome>;
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
        yield {
          type: "progress",
          taskId,
          message: `${model} is rate limited; waiting ${Math.ceil(pause / 1000)}s`,
        };
        await sleep(pause, signal);
        if (signal.aborted) return;
      }
      yield { type: "progress", taskId, message: `reviewing with ${model}` };
      // Spend is reported while the attempt runs, so a run's spend limit
      // can stop it; the finished attempt's total settles the rest.
      const live = new LiveUsage();
      const running = options.attempt(model, (spent) => live.observe(spent));
      const finished = running.then(
        () => false,
        () => false,
      );
      while (await Promise.race([finished, live.changed().then(() => true)])) {
        yield { type: "usage", taskId, ...live.take() };
      }
      const outcome = await running;
      yield { type: "usage", taskId, ...live.rest(outcome.usage) };
      yield { type: "progress", taskId, message: attemptSummary(model, outcome) };
      for (const finding of outcome.findings) yield { type: "finding", taskId, finding, model };

      // A cancelled attempt is neither finished nor the model's fault.
      if (signal.aborted) return;
      if (!outcome.error) {
        health.recordSuccess(model);
        yield { type: "done", taskId };
        return;
      }
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
  yield {
    type: "error",
    taskId,
    error: lastError
      ? `every ${chainName(options)} failed (${lastError})`
      : `every ${chainName(options)} is out of quota for this run`,
    retryable: true,
  };
}

// Hands out what an attempt has spent in increments, each what grew since the
// last one; `rest` settles the finished attempt's total, so the increments
// add up to it and nothing is counted twice.
export class LiveUsage {
  private seen = emptyUsage();
  private given = emptyUsage();
  private wake: (() => void) | undefined;

  observe(spent: Usage): void {
    this.seen = larger(this.seen, spent);
    if (ahead(this.seen, this.given)) {
      this.wake?.();
      this.wake = undefined;
    }
  }

  // Resolves once more has been seen than handed out.
  changed(): Promise<void> {
    if (ahead(this.seen, this.given)) return Promise.resolve();
    return new Promise((resolve) => {
      this.wake = resolve;
    });
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

function larger(a: Usage, b: Usage): Usage {
  return Object.fromEntries(FIELDS.map((f) => [f, Math.max(a[f], b[f])])) as unknown as Usage;
}

function beyond(a: Usage, b: Usage): Usage {
  return Object.fromEntries(FIELDS.map((f) => [f, Math.max(0, a[f] - b[f])])) as unknown as Usage;
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
  for (const model of health.order(options.chain)) {
    for (;;) {
      await sleep(health.pausedFor(model), signal);
      if (signal.aborted) throw new CompletionError("cancelled", usage);
      const outcome = await options.attempt(model);
      usage = addUsage(usage, outcome.usage);
      if (!outcome.error) {
        health.recordSuccess(model);
        return { text: outcome.text, usage };
      }
      if (!outcome.error.retryable) {
        throw new CompletionError(`${model}: ${outcome.error.message}`, usage);
      }
      if (outcome.error.quota && health.recordQuota(model, outcome.error.quota) === "wait") {
        continue;
      }
      if (!outcome.error.quota) health.recordFailure(model);
      lastError = `${model}: ${outcome.error.message}`;
      break;
    }
  }
  if (!lastError) {
    throw new CompletionError(`every ${chainName(options)} is out of quota for this run`, usage);
  }
  throw new CompletionError(`every ${chainName(options)} failed (${lastError})`, usage);
}

function chainName(options: { tier: ModelTier; agent?: string }): string {
  return options.agent === undefined
    ? `${options.tier} model`
    : `model of ${options.agent}'s own chain`;
}
