export interface ModelRef {
  providerID: string;
  modelID: string;
}

export function parseModel(model: string): ModelRef {
  const slash = model.indexOf("/");
  if (slash <= 0 || slash === model.length - 1) {
    throw new Error(
      `Model "${model}" must be written as provider/model, for example google/gemini-flash-lite-latest`,
    );
  }
  return { providerID: model.slice(0, slash), modelID: model.slice(slash + 1) };
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

// A circuit breaker per model: after `threshold` consecutive failures the
// model is skipped (open) for a cooldown, then one attempt is let through
// (half-open). Success closes the circuit; failure reopens it for twice as
// long, up to a limit. Tasks go straight to the fallback instead of paying
// for a model that is down.
export class ModelHealth {
  private readonly circuits = new Map<string, Circuit>();
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
  order(chain: readonly string[]): string[] {
    const now = this.now();
    const available = chain.filter((m) => (this.circuits.get(m)?.openUntil ?? 0) <= now);
    if (available.length > 0) return available;
    return [...chain].sort(
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
  }
}
