import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent, AgentRuntime, AgentTaskSpec } from "@open-cr-agent/core";
import { LocalGitAdapter } from "@open-cr-agent/vcs-local";
import { afterEach, describe, expect, it } from "vitest";
import type { ReviewDeps } from "./review/command.js";
import { run } from "./run.js";

function capture() {
  let text = "";
  return { write: (chunk: string) => (text += chunk), text: () => text };
}

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function repoWithChange(): string {
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

type Script = (spec: AgentTaskSpec) => AsyncIterable<AgentEvent>;

function deps(cwd: string, script: Script, extra: Partial<ReviewDeps> = {}): ReviewDeps {
  const runtime: AgentRuntime = { name: "fake", runTask: (spec) => script(spec) };
  return {
    cwd,
    env: {},
    createVcs: (options) => new LocalGitAdapter(options),
    createRuntime: () => runtime,
    writeFile: async (path, content) => writeFileSync(path, content),
    now: Date.now,
    heartbeatMs: 60_000,
    ...extra,
  };
}

const critical: Script = async function* (spec) {
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

describe("ocra", () => {
  it("prints the version and usage", async () => {
    const out = capture();
    expect(await run(["--version"], out, capture())).toBe(0);
    expect(out.text()).toBe("0.0.0\n");
    const usage = capture();
    expect(await run([], usage, capture())).toBe(0);
    expect(usage.text()).toContain("Usage: ocra");
  });

  it("rejects unknown commands and options", async () => {
    const err = capture();
    expect(await run(["nope"], capture(), err)).toBe(2);
    expect(err.text()).toContain("Unknown command: nope");
    expect(await run(["--nope"], capture(), capture())).toBe(2);
  });
});

describe("ocra review", () => {
  it("reviews the working tree, prints findings and exits 1 on critical findings", async () => {
    const cwd = repoWithChange();
    const out = capture();
    const err = capture();
    expect(await run(["review"], out, err, deps(cwd, critical))).toBe(1);

    expect(out.text()).toContain(
      "app.ts\n  critical   L2        Negative retry count disables retries",
    );
    expect(err.text()).toContain("[ocra] Reviewing: Working tree changes");
    expect(err.text()).toContain("[ocra] correctness-1 completed in");

    const sessions = readdirSync(join(cwd, ".ocra", "sessions"));
    expect(sessions).toHaveLength(1);
    const sessionDir = join(cwd, ".ocra", "sessions", sessions[0] as string);
    expect(existsSync(join(sessionDir, "events.jsonl"))).toBe(true);
    expect(JSON.parse(readFileSync(join(sessionDir, "report.json"), "utf8")).findings).toHaveLength(
      1,
    );
  });

  it("writes JSON to a file and exits 0 without critical findings", async () => {
    const cwd = repoWithChange();
    const clean: Script = async function* (spec) {
      yield { type: "done", taskId: spec.taskId };
    };
    const out = capture();
    expect(
      await run(
        ["review", "--format", "json", "--output", "r.json"],
        out,
        capture(),
        deps(cwd, clean),
      ),
    ).toBe(0);
    expect(out.text()).toBe("");
    expect(JSON.parse(readFileSync(join(cwd, "r.json"), "utf8"))).toMatchObject({
      findings: [],
      tier: "trivial",
    });
  });

  it("exits 2 when no review task completes", async () => {
    const cwd = repoWithChange();
    const broken: Script = async function* () {
      yield* [];
      throw new Error("OpenCodeRuntime.runTask is not implemented yet");
    };
    const err = capture();
    expect(await run(["review"], capture(), err, deps(cwd, broken))).toBe(2);
    expect(err.text()).toContain("correctness-1 failed");
    expect(err.text()).toContain("No review task completed");
  });

  it("reports usage errors, git errors and config errors with exit 2", async () => {
    const cwd = repoWithChange();
    const usage = capture();
    expect(await run(["review", "--to", "x"], capture(), usage, deps(cwd, critical))).toBe(2);
    expect(usage.text()).toContain("--to requires --from");

    const git = capture();
    expect(await run(["review", "--commit", "nope"], capture(), git, deps(cwd, critical))).toBe(2);
    expect(git.text()).toBe("ocra: Unknown commit: nope\n");

    execFileSync("mkdir", ["-p", join(cwd, ".ocra")]);
    writeFileSync(join(cwd, ".ocra", "config.json"), '{"concurrency": "high"}');
    const config = capture();
    expect(await run(["review"], capture(), config, deps(cwd, critical))).toBe(2);
    expect(config.text()).toContain("ocra: .ocra/config.json is invalid");
  });

  it("prints review help", async () => {
    const out = capture();
    expect(await run(["review", "--help"], out, capture(), deps(".", critical))).toBe(0);
    expect(out.text()).toContain("Usage: ocra review [options]");
  });
});
