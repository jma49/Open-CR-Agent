import { quoteSignature } from "../anchor/quote.js";
import type {
  AgentRuntime,
  CompletionRequest,
  ReviewContext,
  SyntaxChecker,
} from "../contracts.js";
import type { Finding } from "../domain.js";
import type { FixCandidate } from "./select.js";

export const SOURCE = [
  "export function first(items: string[]) {",
  "  return items[0].trim();",
  "}",
  "",
  "export function total(prices: number[]) {",
  "  let sum = 0;",
  "  for (let i = 0; i <= prices.length; i++) sum += prices[i];",
  "  return sum;",
  "}",
].join("\n");

export function anchored(
  start: number,
  end: number,
  overrides: Partial<Finding> = {},
  content = SOURCE,
): FixCandidate {
  const lineRange = { start, end };
  const quote = quoteSignature(content, lineRange);
  return {
    id: `id-${start}`,
    fingerprint: `fp-${start}`,
    reviewer: "correctness",
    category: "correctness",
    severity: "warning",
    file: "src/a.ts",
    existingCode: content
      .split("\n")
      .slice(start - 1, end)
      .join("\n"),
    title: `problem at ${start}`,
    body: "body",
    evidence: [],
    lineRange,
    ...(quote ? { quote } : {}),
    provenance: { task: "t1" },
    anchor: { method: "hunk", inDiff: true },
    status: "new",
    ...overrides,
  };
}

// Counts unbalanced braces in TypeScript; knows no other language.
export const braceSyntax: SyntaxChecker = {
  async errors(path, content) {
    if (!path.endsWith(".ts")) return undefined;
    let depth = 0;
    let errors = 0;
    for (const char of content) {
      if (char === "{") depth += 1;
      if (char === "}") depth -= 1;
      if (depth < 0) {
        errors += 1;
        depth = 0;
      }
    }
    return errors + depth;
  },
};

export function contextOf(files: Record<string, string>): ReviewContext {
  return {
    readFile: async (path) => files[path],
    readDiff: () => undefined,
    searchCode: async () => [],
  };
}

export const usage = {
  inputTokens: 10,
  outputTokens: 2,
  reasoningTokens: 0,
  cachedTokens: 0,
  costUsd: 0.001,
};

export function fixerRuntime(
  answer: (request: CompletionRequest) => string,
): AgentRuntime & { requests: CompletionRequest[] } {
  const requests: CompletionRequest[] = [];
  return {
    name: "fake",
    requests,
    runTask: () => {
      throw new Error("unused");
    },
    complete: async (request) => {
      requests.push(request);
      return { text: answer(request), usage };
    },
  };
}
