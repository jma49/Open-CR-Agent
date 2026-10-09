import { writeFileSync } from "node:fs";
import type { AgentEvent, AgentTaskSpec, OcraPlugin } from "@open-cr-agent/core";
import { scratchRepos } from "@open-cr-agent/test-support";
import type { ReviewDeps } from "./commands/review/deps.js";
import { BUILTIN_PLUGINS } from "./commands/review.js";

// Fakes shared by the CLI's end-to-end tests: a scratch repository with one
// change, captured output, and dependencies with a scripted runtime.
export function capture() {
  let text = "";
  return { write: (chunk: string) => (text += chunk), text: () => text };
}

const repos = scratchRepos("ocra-cli-");
export const disposed = { count: 0 };

// Call from afterEach: removes the repositories made since the last call.
export const removeRepos = repos.removeAll;

export function repoWithChange(): string {
  const repo = repos.create();
  repo.commit("init", { "app.ts": "export const limit = 10;\n" });
  repo.write("app.ts", "export const limit = 10;\nexport const retries = -1;\n");
  return repo.dir;
}

export type Script = (spec: AgentTaskSpec) => AsyncIterable<AgentEvent>;

// What the fake machine seals its sessions with.
const TEST_SESSION_KEY = "ab".repeat(32);

// With `verifier`, the fake runtime answers Verify by confirming every
// finding and the judge with no changes.
export function deps(
  cwd: string,
  script: Script,
  extra: Partial<ReviewDeps> = {},
  verifier = false,
): ReviewDeps {
  const usage = {
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cachedTokens: 0,
    costUsd: 0,
  };
  const fakeRuntime: OcraPlugin = {
    name: "runtime-opencode",
    configure(ctx) {
      ctx.registerRuntime("opencode", () => ({
        name: "fake",
        runTask: (spec) => script(spec),
        ...(verifier
          ? {
              complete: async (request: { tier: string }) => ({
                text: request.tier === "top" ? "{}" : '[{"index":0,"verdict":"confirmed"}]',
                usage,
              }),
            }
          : {}),
        dispose: async () => {
          disposed.count += 1;
        },
      }));
    },
  };
  return {
    cwd,
    env: {},
    sessionKey: async () => TEST_SESSION_KEY,
    builtinPlugins: BUILTIN_PLUGINS,
    runtimes: { opencode: async () => fakeRuntime },
    writeFile: async (path, content) => writeFileSync(path, content),
    now: Date.now,
    heartbeatMs: 60_000,
    ...extra,
  };
}

export const critical: Script = async function* (spec) {
  yield {
    type: "finding",
    taskId: spec.taskId,
    finding: {
      category: "correctness",
      severity: "critical",
      file: "app.ts",
      existingCode: "export const retries = -1;",
      title: "Negative retry count disables retries",
      body: "The retry loop runs while attempts < retries, so -1 never retries.",
      evidence: [],
    },
  };
  yield { type: "done", taskId: spec.taskId };
};
