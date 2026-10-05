import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_AGENT_STEPS } from "@open-cr-agent/core";
import { describe, expect, it } from "vitest";
import { main } from "./cli.js";
import type { ExecResult } from "./exec.js";
import { ocraBuild } from "./ocra-build.js";

async function cliRoot(version: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "ocra-build-"));
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "cli", version }));
  return root;
}

// Answers git like a checkout at `head` with `changes` not committed, or
// like a directory outside any repository.
function git(head?: string, changes = "") {
  const asked: string[][] = [];
  const answer = async (args: readonly string[]): Promise<ExecResult> => {
    asked.push([...args]);
    if (head === undefined) return { stdout: "", stderr: "not a git repository", exitCode: 128 };
    return { stdout: args[0] === "rev-parse" ? `${head}\n` : changes, stderr: "", exitCode: 0 };
  };
  return { asked, answer };
}

describe("ocraBuild", () => {
  it("records the CLI's version, its checkout's commit and changes, and the step cap", async () => {
    const root = await cliRoot("0.6.0");
    const commit = "0123456789abcdef0123456789abcdef01234567";
    expect(await ocraBuild(root, git(commit, " M packages/core/src/x.ts\n").answer)).toEqual({
      version: "0.6.0",
      commit,
      dirty: true,
      maxAgentSteps: MAX_AGENT_STEPS,
    });
    expect(await ocraBuild(root, git(commit).answer)).toMatchObject({ dirty: false });
  });

  it("records no commit for a CLI outside a git checkout", async () => {
    const root = await cliRoot("0.6.0");
    const fake = git();
    expect(await ocraBuild(root, fake.answer)).toEqual({
      version: "0.6.0",
      maxAgentSteps: MAX_AGENT_STEPS,
    });
    expect(fake.asked).toEqual([["rev-parse", "--verify", "HEAD"]]);
  });
});

describe("a run.json that records the build", () => {
  it("is read back, and the summary names the build", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ocra-rescore-"));
    const goldenDir = join(dir, "golden");
    await mkdir(goldenDir);
    const info = {
      runId: "r",
      createdAt: "2026-10-04T00:00:00Z",
      selection: { dataset: "golden", goldenDir },
      models: {},
      judge: "mock",
      ocra: { version: "0.6.0", commit: "0123456789abcdef", dirty: true, maxAgentSteps: 30 },
    };
    await writeFile(join(dir, "run.json"), JSON.stringify({ info, ids: [] }));
    let text = "";
    const out = { write: (chunk: string) => (text += chunk) };
    expect(await main(["score", dir, "--mock-judge"], out, out)).toBe(0);
    expect(await readFile(join(dir, "summary.md"), "utf8")).toContain(
      "- ocra: 0.6.0 at 0123456789ab with uncommitted changes, 30 steps per review agent",
    );
  });
});
