import type { Usage } from "./contracts.js";

// Codes are a contract (manual: Embedding, Stability): callers branch on the
// code, never on the message, so a message may be reworded but a code only
// changes under the 0.x rule for contracts.
export const OCRA_ERROR_CODES = [
  // Configuration: .ocra/config.json, rules, memory, review options, models.
  "CONFIG_INVALID",
  "CONFIG_CREDENTIALS_MISSING",
  // Input given on the command line or in a file passed to ocra.
  "INPUT_USAGE",
  "INPUT_INVALID",
  // The access policy refused a path.
  "ACCESS_DENIED",
  "PLUGIN_INVALID",
  // Where the change comes from.
  "VCS_GIT_FAILED",
  "VCS_API_FAILED",
  "VCS_REF_UNKNOWN",
  "VCS_NOT_READY",
  // ocra Cloud, for a signed-in CLI.
  "CLOUD_API_FAILED",
  // What runs the models.
  "RUNTIME_START_FAILED",
  "RUNTIME_FAILED",
  "RUNTIME_INVALID_OUTPUT",
  "BUDGET_EXHAUSTED",
  // A broken invariant or a misused object: a bug, in ocra or in its caller.
  "INTERNAL",
] as const;

export type OcraErrorCode = (typeof OCRA_ERROR_CODES)[number];

export class OcraError extends Error {
  readonly code: OcraErrorCode;

  constructor(code: OcraErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.code = code;
    this.name = "OcraError";
  }
}

export function isOcraError(error: unknown, code?: OcraErrorCode): error is OcraError {
  return error instanceof OcraError && (code === undefined || error.code === code);
}

// A helper completion that failed on every model has still spent tokens on
// the attempts; callers record them so reports and spend limits stay true.
export class CompletionError extends OcraError {
  readonly usage: Usage;

  constructor(message: string, usage: Usage, options?: { cause?: unknown }) {
    super("RUNTIME_FAILED", message, options);
    this.usage = usage;
    this.name = "CompletionError";
  }
}

export function usageSpent(error: unknown): Usage | undefined {
  return error instanceof CompletionError ? error.usage : undefined;
}

export function errorMessage(error: unknown): string {
  // biome-ignore lint/plugin: the one definition the rule points to
  return error instanceof Error ? error.message : String(error);
}

// The code of a failed system call (ENOENT, EEXIST, …), when the error has one.
export function errnoCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
}

export function isNotFound(error: unknown): boolean {
  return errnoCode(error) === "ENOENT";
}
