import { CONTEXT_SOURCES, type ContextSource } from "@open-cr-agent/core/internal";

// What `ocra-eval context` reads of each case's plan: its tasks' first
// prompts by source (ADR-0057).
export interface CaseContext {
  id: string;
  tasks: readonly {
    promptTokens: number;
    context?: readonly {
      source: ContextSource;
      tokens: number;
      cut?: number;
      duplicateTokens?: number;
    }[];
  }[];
}

interface SourceSummary {
  source: ContextSource;
  // Tasks whose prompt has the source, of all tasks.
  tasks: number;
  tokens: number;
  meanPerTask: number;
  maxPerTask: number;
  cut: number;
  duplicateTokens: number;
}

export interface ContextSummary {
  cases: number;
  tasks: number;
  promptTokens: number;
  sources: SourceSummary[];
}

export function summarizeContext(cases: readonly CaseContext[]): ContextSummary {
  const sums = new Map<ContextSource, SourceSummary>(
    CONTEXT_SOURCES.map((source) => [
      source,
      { source, tasks: 0, tokens: 0, meanPerTask: 0, maxPerTask: 0, cut: 0, duplicateTokens: 0 },
    ]),
  );
  let tasks = 0;
  let promptTokens = 0;
  for (const c of cases) {
    for (const task of c.tasks) {
      tasks += 1;
      promptTokens += task.promptTokens;
      for (const part of task.context ?? []) {
        const sum = sums.get(part.source);
        if (!sum) continue;
        sum.tasks += 1;
        sum.tokens += part.tokens;
        sum.maxPerTask = Math.max(sum.maxPerTask, part.tokens);
        sum.cut += part.cut ?? 0;
        sum.duplicateTokens += part.duplicateTokens ?? 0;
      }
    }
  }
  const sources = [...sums.values()].map((s) => ({
    ...s,
    meanPerTask: s.tasks === 0 ? 0 : Math.round(s.tokens / s.tasks),
  }));
  return { cases: cases.length, tasks, promptTokens, sources };
}

export function renderContext(summary: ContextSummary, without: readonly string[] = []): string {
  const share = (n: number) =>
    summary.promptTokens === 0 ? "0.0" : ((100 * n) / summary.promptTokens).toFixed(1);
  const lines = [
    "# Review context by source",
    "",
    `${summary.cases} case(s), ${summary.tasks} review task(s), ${summary.promptTokens} first-prompt tokens (four characters per token; no model calls).${without.length > 0 ? ` Left out: ${without.join(", ")}.` : ""} "Cut" counts texts held to a limit and lists cut short; "duplicate" counts lines an earlier part of the same prompt already holds.`,
    "",
    "| Source | Tasks | Tokens | Share | Mean per task | Max per task | Cut | Duplicate |",
    "|---|---|---|---|---|---|---|---|",
    ...summary.sources.map(
      (s) =>
        `| ${s.source} | ${s.tasks} | ${s.tokens} | ${share(s.tokens)}% | ${s.meanPerTask} | ${s.maxPerTask} | ${s.cut} | ${s.duplicateTokens} |`,
    ),
  ];
  return `${lines.join("\n")}\n`;
}
