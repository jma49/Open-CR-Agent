import {
  type AgentEvent,
  emptyUsage,
  type ModelTier,
  REVIEW_TOOLS,
  type Usage,
} from "@open-cr-agent/core";
import type { ModelHealth } from "./models.js";
import { sleep } from "./quota.js";
import type { SessionOutcome } from "./session-outcome.js";

export interface FailbackOptions {
  taskId: string;
  tier: ModelTier;
  chain: readonly string[];
  health: ModelHealth;
  signal: AbortSignal;
  // onUsage receives what the attempt has spent so far, as it grows.
  attempt(model: string, onUsage: (spent: Usage) => void): Promise<SessionOutcome>;
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
      ? `every ${options.tier} model failed (${lastError})`
      : `every ${options.tier} model is out of quota for this run`,
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

// Which tools an attempt spent its steps on, and whether it finished: a
// review that never called task_done was cut off, usually by the step cap.
function attemptSummary(model: string, outcome: SessionOutcome): string {
  const { inputTokens, outputTokens, reasoningTokens, costUsd } = outcome.usage;
  const resumed = outcome.resumed ? ", resumed after stopping early" : "";
  return `${model}: ${outcome.steps} step(s), ${toolSummary(outcome.toolCalls)}${resumed}, ${inputTokens} in / ${outputTokens} out / ${reasoningTokens} reasoning tokens, $${costUsd.toFixed(4)}`;
}

export function toolSummary(toolCalls: readonly string[]): string {
  if (toolCalls.length === 0) return "no tool calls";
  // MCP tools carry the server's name as a prefix (MCP_SERVER in runtime.ts).
  const names = toolCalls.map((t) => t.replace(/^ocra_/, ""));
  const counts = new Map<string, number>();
  for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1);
  const byUse = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const finished = names.includes(REVIEW_TOOLS.taskDone) ? "" : "; no task_done";
  return `${toolCalls.length} tool call(s) (${byUse.map(([n, c]) => `${n} ${c}`).join(", ")}${finished})`;
}
