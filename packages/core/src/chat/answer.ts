import { oneShot } from "../agent/model-call.js";
import type { AgentCallSettings } from "../agent/settings.js";
import type { AgentRuntime, Usage } from "../contracts.js";
import { OcraError } from "../errors.js";
import { buildAnswerPrompt, type Question, type QuestionContext } from "./prompt.js";

const ANSWER_TIMEOUT_MS = 120_000;
const MAX_ANSWER_CHARS = 4_000;

export interface AnswerOptions {
  runtime: AgentRuntime;
  signal: AbortSignal;
  onUsage: (usage: Usage) => void;
  call?: AgentCallSettings | undefined;
}

// One plain completion on the writer role (ADR-0048). Throws what the call
// threw: a question nobody answers is the caller's to report.
export async function answerQuestion(
  question: Question,
  context: QuestionContext,
  options: AnswerOptions,
): Promise<string> {
  const ask = oneShot(options.runtime, options.onUsage);
  if (!ask) {
    throw new OcraError(
      "RUNTIME_START_FAILED",
      `the ${options.runtime.name} runtime makes no plain completions, which an answer needs`,
    );
  }
  const prompt = buildAnswerPrompt(question, context);
  const answer = await ask(
    {
      tier: "standard",
      agent: "writer",
      call: options.call,
      system: prompt.system,
      user: prompt.user,
      timeoutMs: ANSWER_TIMEOUT_MS,
    },
    options.signal,
  );
  const text = answer.trim();
  if (text === "") throw new OcraError("RUNTIME_INVALID_OUTPUT", "the answer is empty");
  return text.length > MAX_ANSWER_CHARS ? `${text.slice(0, MAX_ANSWER_CHARS - 1)}…` : text;
}
