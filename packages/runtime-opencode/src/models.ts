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

// A model that keeps failing with retryable errors is skipped for the rest of
// the run, so later tasks go straight to its fallback instead of waiting
// through the provider's retries again.
export class ModelHealth {
  private readonly failures = new Map<string, number>();

  constructor(private readonly threshold = 2) {}

  order(chain: readonly string[]): string[] {
    const healthy = chain.filter((m) => (this.failures.get(m) ?? 0) < this.threshold);
    return healthy.length > 0 ? healthy : [...chain];
  }

  recordFailure(model: string): void {
    this.failures.set(model, (this.failures.get(model) ?? 0) + 1);
  }

  recordSuccess(model: string): void {
    this.failures.delete(model);
  }
}
