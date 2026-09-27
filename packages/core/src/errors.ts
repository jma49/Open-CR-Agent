import type { Usage } from "./contracts.js";

// A helper completion that failed on every model has still spent tokens on
// the attempts; callers record them so reports and spend limits stay true.
export class CompletionError extends Error {
  constructor(
    message: string,
    readonly usage: Usage,
  ) {
    super(message);
  }
}

export function usageSpent(error: unknown): Usage | undefined {
  return error instanceof CompletionError ? error.usage : undefined;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
