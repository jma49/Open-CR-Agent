import type {
  AgentEvent,
  AgentRuntime,
  AgentTaskSpec,
  CompletionRequest,
  IncompleteEnding,
} from "../contracts.js";
import { parseUnifiedDiff } from "../diff/parse.js";
import { fixerRuntime, SOURCE, usage } from "../fix/fix.fakes.js";
import type { ChangeChecks, ChangeCommit, CommitResult, RoundNote, VcsAdapter } from "../vcs.js";
import type { StoredFinding } from "./fix-finding.js";

export const HEAD = "a".repeat(40);
export const SHA = "c".repeat(40);
const LINES = SOURCE.split("\n");
export const TRIM = "  return items[0].trim();";
export const TRIM_FIXED = "  return items[0]?.trim();";
export const LOOP = "  for (let i = 0; i <= prices.length; i++) sum += prices[i];";
// The loop is line 7 of the file: how a prompt names the lines it is about.
export const LOOP_AT = '<ocra_lines_to_replace start="7" end="7">';
export const LOOP_FIXED = "  for (let i = 0; i < prices.length; i++) sum += prices[i];";

function added(path: string, lines: readonly string[]): string {
  return [
    `diff --git a/${path} b/${path}`,
    "new file mode 100644",
    "index 0000000..2222222",
    "--- /dev/null",
    `+++ b/${path}`,
    `@@ -0,0 +1,${lines.length} @@`,
    ...lines.map((l) => `+${l}`),
  ].join("\n");
}

const FILES: Record<string, string> = { "src/a.ts": SOURCE, ".github/scripts/a.ts": SOURCE };

export function fakeVcs(
  commit?: (commit: ChangeCommit) => Promise<CommitResult>,
  checks?: () => Promise<ChangeChecks>,
) {
  const commits: ChangeCommit[] = [];
  const notes: RoundNote[] = [];
  const vcs: VcsAdapter = {
    name: "fake",
    getChangeRequest: async () => ({
      id: "7",
      title: "Sum prices",
      description: "",
      baseSha: "b".repeat(40),
      headSha: HEAD,
    }),
    getDiff: async () =>
      parseUnifiedDiff(
        Object.keys(FILES)
          .map((path) => added(path, LINES))
          .join("\n"),
      ),
    readFile: async (path) => FILES[path],
    searchCode: async () => [],
    getPriorReview: async () => undefined,
    publish: async () => ({ warnings: [] }),
    commit: async (change) => {
      commits.push(change);
      return commit ? commit(change) : { committed: true, sha: SHA };
    },
    note: async (round) => {
      notes.push(round);
    },
    ...(checks ? { checks } : {}),
  };
  return { vcs, commits, notes };
}

export function finding(fingerprint: string, code: string, extra: Partial<StoredFinding> = {}) {
  return {
    fingerprint,
    reviewer: "correctness",
    severity: "warning",
    category: "correctness",
    file: "src/a.ts",
    title: `Problem ${fingerprint}`,
    body: "It breaks.",
    existingCode: code.trim(),
    ...extra,
  } satisfies StoredFinding;
}

export const trim = finding("trim", TRIM);
export const loop = finding("loop", LOOP);

// The fixer answers by the lines it is shown; the verifier agrees unless told.
export function answers(verdict = "resolves", fixes: Record<string, string | null> = {}) {
  return (request: CompletionRequest) => {
    if (request.agent === "verifier") return JSON.stringify({ verdict });
    const replacement = request.user.includes(LOOP_AT)
      ? "loop" in fixes
        ? fixes.loop
        : LOOP_FIXED
      : "trim" in fixes
        ? fixes.trim
        : TRIM_FIXED;
    return JSON.stringify([{ index: 0, replacement }]);
  };
}

export interface Call {
  tool: string;
  args: Record<string, unknown>;
}

export interface Script {
  calls: readonly Call[];
  ended?: IncompleteEnding;
  error?: string;
}

// A runtime that takes a task's toolset and runs a scripted agent against
// it: each call goes to the tool the task offers under that name.
export function agentRuntime(script: Script, verdict = "resolves") {
  const completions = fixerRuntime(answers(verdict));
  const tasks: AgentTaskSpec[] = [];
  const outputs: string[] = [];
  const runtime: AgentRuntime = {
    ...completions,
    toolsets: true,
    async *runTask(spec): AsyncIterable<AgentEvent> {
      tasks.push(spec);
      for (const call of script.calls) {
        const tool = spec.toolset?.tools.find((t) => t.name === call.tool);
        outputs.push(tool ? await tool.execute(call.args, spec.context) : "unknown tool");
      }
      yield { type: "usage", taskId: spec.taskId, ...usage };
      if (script.error) {
        yield { type: "error", taskId: spec.taskId, error: script.error, retryable: false };
      } else {
        yield {
          type: "done",
          taskId: spec.taskId,
          ...(script.ended ? { ended: script.ended } : {}),
        };
      }
    },
  };
  return { runtime, tasks, outputs, requests: completions.requests };
}

export const edit = (old: string, replacement: string, path = "src/a.ts"): Call => ({
  tool: "edit",
  args: { path, old, new: replacement },
});
export const DONE: Call = { tool: "task_done", args: {} };
