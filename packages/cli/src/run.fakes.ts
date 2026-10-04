import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent, AgentTaskSpec, OcraPlugin } from "@open-cr-agent/core";
import { BUILTIN_PLUGINS, type ReviewDeps } from "./commands/review.js";

// Fakes shared by the CLI's end-to-end tests: a scratch repository with one
// change, captured output, and dependencies with a scripted runtime.
export function capture() {
  let text = "";
  return { write: (chunk: string) => (text += chunk), text: () => text };
}

const dirs: string[] = [];
export const disposed = { count: 0 };

// Call from afterEach: removes the repositories made since the last call.
export function removeRepos(): void {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
}

export function repoWithChange(): string {
  const dir = mkdtempSync(join(tmpdir(), "ocra-cli-"));
  dirs.push(dir);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  writeFileSync(join(dir, "app.ts"), "export const limit = 10;\n");
  git("add", "-A");
  git("commit", "-q", "-m", "init");
  writeFileSync(join(dir, "app.ts"), "export const limit = 10;\nexport const retries = -1;\n");
  return dir;
}

export type Script = (spec: AgentTaskSpec) => AsyncIterable<AgentEvent>;

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
