import { parseJsonAnswer } from "../agent/json.js";
import { oneShot } from "../agent/model-call.js";
import type { AgentCallSettings } from "../agent/settings.js";
import type { AgentRuntime, Usage } from "../contracts.js";
import type { ChangeRequest, FileDiff } from "../domain.js";
import { errorMessage, OcraError } from "../errors.js";
import type { MergeCheck, MergeCheckResult } from "./merge-check.js";
import {
  buildMergeChecksPrompt,
  type MergeChecksResponse,
  mergeChecksResponseSchema,
} from "./prompt.js";

const MERGE_CHECKS_TIMEOUT_MS = 120_000;
const MAX_REASON_CHARS = 300;

export interface MergeChecksOptions {
  runtime: AgentRuntime;
  changeRequest: ChangeRequest;
  files: readonly FileDiff[];
  checks: readonly MergeCheck[];
  signal: AbortSignal;
  onUsage: (usage: Usage) => void;
  call?: AgentCallSettings | undefined;
}

export interface MergeChecksResult {
  results: MergeCheckResult[];
  warnings: string[];
}

// One plain completion judges every check. A failure leaves each one
// inconclusive, never failed, and costs the review nothing.
export async function judgeMergeChecks(options: MergeChecksOptions): Promise<MergeChecksResult> {
  const { checks } = options;
  if (checks.length === 0) return { results: [], warnings: [] };
  const ask = oneShot(options.runtime, options.onUsage);
  if (!ask) return notJudged(checks, "the runtime makes no plain completions");
  try {
    const prompt = buildMergeChecksPrompt(options.changeRequest, options.files, checks);
    const answer = await ask(
      {
        tier: "top",
        agent: "judge",
        call: options.call,
        system: prompt.system,
        user: prompt.user,
        timeoutMs: MERGE_CHECKS_TIMEOUT_MS,
      },
      options.signal,
    );
    const parsed = mergeChecksResponseSchema.safeParse(parseJsonAnswer(answer));
    if (!parsed.success) {
      throw new OcraError("RUNTIME_INVALID_OUTPUT", "the check outcomes are not the expected JSON");
    }
    return { results: fromResponse(parsed.data, checks), warnings: [] };
  } catch (error) {
    const judged = notJudged(checks, "the check call failed");
    return { ...judged, warnings: [`${judged.warnings[0]} (${errorMessage(error)})`] };
  }
}

export function notJudged(checks: readonly MergeCheck[], cause: string): MergeChecksResult {
  return {
    results: checks.map((c) => inconclusive(c, `not judged: ${cause}`)),
    warnings: [`pre-merge checks were not judged: ${cause}`],
  };
}

// Which checks there are is the configuration's to say: an outcome for an
// unknown id is dropped, the first for an id wins, and a check the model
// left out is inconclusive.
export function fromResponse(
  response: MergeChecksResponse,
  checks: readonly MergeCheck[],
): MergeCheckResult[] {
  const answered = new Map<string, MergeChecksResponse["checks"][number]>();
  for (const entry of response.checks) {
    if (!answered.has(entry.id)) answered.set(entry.id, entry);
  }
  return checks.map((check) => {
    const entry = answered.get(check.id);
    if (!entry) return inconclusive(check, "the judge gave no outcome for it");
    const reason = clip(entry.reason.replace(/\s+/g, " ").trim(), MAX_REASON_CHARS);
    return { ...check, outcome: entry.outcome, reason };
  });
}

function inconclusive(check: MergeCheck, reason: string): MergeCheckResult {
  return { ...check, outcome: "inconclusive", reason };
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
