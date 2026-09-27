import type { AgentEvent, AgentRuntime, AgentTaskSpec, VcsAdapter } from "../contracts.js";
import { parseUnifiedDiff } from "../diff/parse.js";
import type { ReportedFinding } from "../domain.js";

// Fakes shared by the runReview tests.
export function patch(path: string, added: string): string {
  return [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    "@@ -1 +1,2 @@",
    " keep",
    `+${added}`,
  ].join("\n");
}

export function vcs(files: Record<string, string>, diffText: string): VcsAdapter {
  return {
    name: "fake",
    getChangeRequest: async () => ({
      id: "1",
      title: "t",
      description: "d",
      baseSha: "b",
      headSha: "h",
    }),
    getDiff: async () => parseUnifiedDiff(diffText),
    readFile: async (path) => files[path],
    searchCode: async () => [],
    getPriorReview: async () => undefined,
    publish: async () => ({ warnings: [] }),
  };
}

export type Script = (spec: AgentTaskSpec, signal: AbortSignal) => AsyncIterable<AgentEvent>;

export function runtime(script: Script): AgentRuntime & { specs: AgentTaskSpec[] } {
  const specs: AgentTaskSpec[] = [];
  return {
    name: "fake",
    specs,
    runTask(spec, signal) {
      specs.push(spec);
      return script(spec, signal);
    },
  };
}

export function finding(
  file: string,
  existingCode: string,
  overrides: Partial<ReportedFinding> = {},
): ReportedFinding {
  return {
    category: "correctness",
    severity: "warning",
    file,
    existingCode,
    title: "t",
    body: "b",
    evidence: [],
    ...overrides,
  };
}

export const twoFiles = [patch("src/a.ts", "const a = 1;"), patch("src/b.ts", "const b = 2;")].join(
  "\n",
);
