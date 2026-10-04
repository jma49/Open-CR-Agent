import { OcraError } from "../errors.js";

// Models often wrap JSON in a Markdown fence or add a sentence around it.
export function parseJsonAnswer(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text)?.[1];
  const candidate = (fenced ?? text).trim();
  const start = candidate.search(/[[{]/);
  if (start < 0) throw new OcraError("RUNTIME_INVALID_OUTPUT", "the model answered without JSON");
  const end = Math.max(candidate.lastIndexOf("]"), candidate.lastIndexOf("}"));
  return JSON.parse(candidate.slice(start, end + 1));
}
