import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { AgentTaskSpec } from "@open-cr-agent/core";
import { afterEach, describe, expect, it } from "vitest";
import { capture, deps, removeRepos, repoWithChange } from "../../run.fakes.js";
import { run } from "../../run.js";

afterEach(removeRepos);

// Four changed files: without a grouping model, one review task per file.
function repoWithFourFiles(): string {
  const cwd = repoWithChange();
  for (const name of ["b", "c", "d"]) {
    writeFileSync(join(cwd, `${name}.ts`), `export const ${name} = 1;\n`);
  }
  return cwd;
}

// The task that reviews c.ts is refused for quota while `refuse` is set.
function reviewing(seen: AgentTaskSpec[], refuse: { on: boolean }) {
  return async function* (spec: AgentTaskSpec) {
    seen.push(spec);
    if (refuse.on && spec.userPrompt.includes("export const c = 1;")) {
      yield {
        type: "error" as const,
        taskId: spec.taskId,
        error: "quota exceeded",
        retryable: true,
      };
      return;
    }
    yield {
      type: "usage" as const,
      taskId: spec.taskId,
      inputTokens: 10,
      outputTokens: 1,
      reasoningTokens: 0,
      cachedTokens: 0,
      costUsd: 0.01,
    };
    yield { type: "done" as const, taskId: spec.taskId };
  };
}

// The report goes outside the repository, where it would be a changed file.
async function review(cwd: string, script: ReturnType<typeof reviewing>, flags: string[] = []) {
  const err = capture();
  const output = join(mkdtempSync(join(tmpdir(), "ocra-resume-report-")), "r.json");
  const code = await run(
    ["review", "--format", "json", "--output", output, ...flags],
    capture(),
    err,
    deps(cwd, script),
  );
  const report = JSON.parse(readFileSync(output, "utf8"));
  rmSync(dirname(output), { recursive: true, force: true });
  return { code, err: err.text(), report };
}

describe("ocra review --resume", () => {
  it("reruns only the task the earlier run lost and pays only for it", async () => {
    const cwd = repoWithFourFiles();
    const seen: AgentTaskSpec[] = [];
    const refuse = { on: true };
    const first = await review(cwd, reviewing(seen, refuse));
    expect(first.report.tasks.length).toBeGreaterThan(1);
    expect(
      first.report.tasks.filter((t: { status: string }) => t.status === "failed"),
    ).toHaveLength(1);

    seen.length = 0;
    refuse.on = false;
    const second = await review(cwd, reviewing(seen, refuse), ["--resume", first.report.runId]);
    expect(second.code).toBe(0);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.userPrompt).toContain("export const c = 1;");
    const reused = second.report.tasks.filter(
      (t: { reusedFrom?: string }) => t.reusedFrom === first.report.runId,
    );
    expect(reused).toHaveLength(first.report.tasks.length - 1);
    expect(second.report.usage.costUsd).toBeCloseTo(0.01);
    expect(second.err).toContain(`reused from ${first.report.runId}`);
  });

  it("names a run without a session", async () => {
    const cwd = repoWithFourFiles();
    const err = capture();
    const code = await run(
      ["review", "--resume", "20260101T000000Z-000000"],
      capture(),
      err,
      deps(cwd, reviewing([], { on: false })),
    );
    expect(code).toBe(2);
    expect(err.text()).toContain("no session log for run 20260101T000000Z-000000");
  });
});
