import type { ModelChains, ModelTier } from "../contracts.js";
import { OcraError } from "../errors.js";
import { MAX_QUOTA_WAIT_MS, QUOTA_RETRIES, type QuotaError } from "./quota.js";

export interface ModelRef {
  providerID: string;
  modelID: string;
}

export function parseModel(model: string): ModelRef {
  const slash = model.indexOf("/");
  if (slash <= 0 || slash === model.length - 1) {
    throw new OcraError(
      "CONFIG_INVALID",
      `Model "${model}" must be written as provider/model, for example google/gemini-flash-lite-latest`,
    );
  }
  return { providerID: model.slice(0, slash), modelID: model.slice(slash + 1) };
}

// The chain a call runs on: the agent's own when the call carries one
// (ADR-0025), else its tier's. Health is kept per model, so a model in two
// chains shares one circuit and one quota.
export function callChain(
  tiers: ModelChains,
  tier: ModelTier,
  own: readonly string[] | undefined,
): readonly string[] {
  return own?.length ? own : (tiers[tier] ?? []);
}

export interface CircuitOptions {
  // Consecutive retryable failures that open the circuit.
  threshold?: number;
  cooldownMs?: number;
  maxCooldownMs?: number;
  now?: () => number;
}

interface Circuit {
  failures: number;
  openUntil?: number;
  cooldownMs: number;
}

interface Quota {
  waits: number;
  pausedUntil: number;
}

// A circuit breaker per model: after `threshold` consecutive failures the
// model is skipped (open) for a cooldown, then one attempt is let through
// (half-open). Success closes the circuit; failure reopens it for twice as
// long, up to a limit. Tasks go straight to the fallback instead of paying
// for a model that is down.
export class ModelHealth {
  private readonly circuits = new Map<string, Circuit>();
  private readonly quotas = new Map<string, Quota>();
  private readonly outOfQuota = new Set<string>();
  private readonly threshold: number;
  private readonly cooldownMs: number;
  private readonly maxCooldownMs: number;
  private readonly now: () => number;

  constructor(options: CircuitOptions = {}) {
    this.threshold = options.threshold ?? 2;
    this.cooldownMs = options.cooldownMs ?? 60_000;
    this.maxCooldownMs = options.maxCooldownMs ?? 10 * 60_000;
    this.now = options.now ?? Date.now;
  }

  // Models whose circuit is closed or half-open, in chain order. When every
  // circuit is open, all models in the order they reopen: a review should
  // still try rather than fail without a request.
  // Models out of quota are left out entirely: another request would only be
  // refused again.
  order(chain: readonly string[]): string[] {
    const now = this.now();
    const usable = chain.filter((m) => !this.outOfQuota.has(m));
    const available = usable.filter((m) => (this.circuits.get(m)?.openUntil ?? 0) <= now);
    if (available.length > 0) return available;
    return [...usable].sort(
      (a, b) => (this.circuits.get(a)?.openUntil ?? 0) - (this.circuits.get(b)?.openUntil ?? 0),
    );
  }

  state(model: string): "closed" | "open" | "half-open" {
    const circuit = this.circuits.get(model);
    if (circuit?.openUntil === undefined) return "closed";
    return circuit.openUntil > this.now() ? "open" : "half-open";
  }

  recordFailure(model: string): void {
    const circuit = this.circuits.get(model) ?? { failures: 0, cooldownMs: this.cooldownMs };
    const probing = this.state(model) === "half-open";
    circuit.failures += 1;
    if (probing || circuit.failures >= this.threshold) {
      circuit.openUntil = this.now() + circuit.cooldownMs;
      circuit.cooldownMs = Math.min(circuit.cooldownMs * 2, this.maxCooldownMs);
      circuit.failures = 0;
    }
    this.circuits.set(model, circuit);
  }

  recordSuccess(model: string): void {
    this.circuits.delete(model);
    this.quotas.delete(model);
  }

  // How long every task should hold off this model (a shared rate-limit pause).
  pausedFor(model: string): number {
    return Math.max(0, (this.quotas.get(model)?.pausedUntil ?? 0) - this.now());
  }

  isOutOfQuota(model: string): boolean {
    return this.outOfQuota.has(model);
  }

  // A rate limit with a short, stated wait pauses the model for every task;
  // a daily limit, no stated wait, a long one, or too many waits in a row
  // mean the model is out of quota for the rest of the run.
  recordQuota(model: string, quota: QuotaError): "wait" | "out_of_quota" {
    const state = this.quotas.get(model) ?? { waits: 0, pausedUntil: 0 };
    const wait = quota.retryAfterMs;
    if (
      quota.daily ||
      wait === undefined ||
      wait > MAX_QUOTA_WAIT_MS ||
      state.waits >= QUOTA_RETRIES
    ) {
      this.outOfQuota.add(model);
      return "out_of_quota";
    }
    state.waits += 1;
    state.pausedUntil = Math.max(state.pausedUntil, this.now() + wait);
    this.quotas.set(model, state);
    return "wait";
  }
}
