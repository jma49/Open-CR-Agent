import type {
  AgentEvent,
  AgentTaskSpec,
  CompletionRequest,
  CompletionResult,
  ModelChains,
  ModelTier,
  Usage,
} from "../contracts.js";
import { OcraError } from "../errors.js";
import type { AttemptOutcome } from "./attempt.js";
import { completeWithFailback, withFailback } from "./failback.js";
import { callChain, ModelHealth } from "./models.js";

// What a runtime does with one model; the ChainRunner does the rest.
export interface ModelAttempts {
  // Why a call cannot run on its chain, checked before any request. `own`:
  // the chain is the agent's own (ADR-0025) rather than its tier's.
  refuse?(chain: readonly string[], own: boolean): OcraError | undefined;
  // Awaited once a call is accepted, before its first attempt: starting a
  // server, say. What it throws, the call throws.
  ready?(): Promise<void>;
  // onUsage receives what the attempt has spent so far, as it grows.
  task(
    model: string,
    spec: AgentTaskSpec,
    signal: AbortSignal,
    onUsage: (spent: Usage) => void,
  ): Promise<AttemptOutcome>;
  complete(model: string, request: CompletionRequest, signal: AbortSignal): Promise<AttemptOutcome>;
}

// The model chain of every call a runtime serves: which chain a call runs on,
// each model's health across the run (quota waits, a circuit breaker), and
// failing over to the next model. A runtime implements single-model
// attempts and hands its runTask and complete to one runner per instance,
// so the health it keeps spans the run.
export class ChainRunner {
  private readonly health = new ModelHealth();

  private readonly models: ModelChains;
  private readonly attempts: ModelAttempts;

  constructor(models: ModelChains, attempts: ModelAttempts) {
    this.models = models;
    this.attempts = attempts;
  }

  async *runTask(spec: AgentTaskSpec, signal: AbortSignal): AsyncIterable<AgentEvent> {
    const own = Boolean(spec.models?.length);
    const chain = callChain(this.models, spec.modelTier, spec.models);
    const refused = this.refusal(spec.modelTier, chain, own);
    if (refused) {
      yield { type: "error", taskId: spec.taskId, error: refused.message, retryable: false };
      return;
    }
    await this.attempts.ready?.();
    yield* withFailback({
      taskId: spec.taskId,
      tier: spec.modelTier,
      ...(own ? { agent: spec.reviewer } : {}),
      chain,
      health: this.health,
      signal,
      attempt: (model, onUsage) => this.attempts.task(model, spec, signal, onUsage),
    });
  }

  // Throws a CompletionError carrying the usage of failed attempts, or the
  // OcraError of a call refused before any request.
  async complete(request: CompletionRequest, signal: AbortSignal): Promise<CompletionResult> {
    const own = Boolean(request.models?.length);
    const chain = callChain(this.models, request.tier, request.models);
    const refused = this.refusal(request.tier, chain, own);
    if (refused) throw refused;
    await this.attempts.ready?.();
    return completeWithFailback({
      tier: request.tier,
      ...(own ? { agent: request.agent ?? request.tier } : {}),
      chain,
      health: this.health,
      signal,
      attempt: (model) => this.attempts.complete(model, request, signal),
    });
  }

  private refusal(tier: ModelTier, chain: readonly string[], own: boolean): OcraError | undefined {
    if (chain.length === 0) return noModel(tier);
    return this.attempts.refuse?.(chain, own);
  }
}

function noModel(tier: ModelTier): OcraError {
  return new OcraError(
    "CONFIG_INVALID",
    `No model configured for the "${tier}" tier; set models.${tier} in .ocra/config.json or OCRA_MODEL_${tier.toUpperCase()}`,
  );
}
