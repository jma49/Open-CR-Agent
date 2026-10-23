import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { main } from "./cli.js";
import { writeSummary } from "./commands/summary.js";
import { comparisonWarnings, type SavedSummary } from "./compare.js";
import { fakeOcra, instance } from "./fake-ocra.fakes.js";
import { createJudge } from "./judges.js";
import type { InstanceResult } from "./results.js";
import { runInstances } from "./runner.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const A = "a".repeat(40);
const B = "b".repeat(40);

// A run reviewed by one or more invocations of ocra-eval, each from an ocra
// checkout at a commit, then scored like `ocra-eval run` scores it.
async function reviewed(
  scratch: string,
  label: string,
  invocations: { commit: string; ids: string[] }[],
): Promise<string> {
  const runDir = join(scratch, label);
  let results: InstanceResult[] = [];
  for (const { commit, ids } of invocations) {
    results = await runInstances(
      ids.map((id) => instance(id)),
      {
        runDir,
        reposDir: scratch,
        command: [process.execPath, fakeOcra(scratch)],
        reviewArgs: ["--temperature", "0"],
        timeoutMs: 30_000,
        prepare: async () => scratch,
        log: () => {},
        ranOn: async (models: readonly string[]) => ({
          at: "2026-10-23T00:00:00.000Z",
          ocra: { version: "0.7.0", commit, dirty: false, maxAgentSteps: 30 },
          runtime: "opencode",
          opencode: { version: "1.18.32" },
          catalog: Object.fromEntries(models.map((m) => [m, { cost: { input: 1, output: 5 } }])),
        }),
      },
    );
  }
  const ids = invocations.at(-1)?.ids ?? [];
  const judge = createJudge(true, {});
  const info = {
    runId: label,
    createdAt: "2026-10-23T00:00:00.000Z",
    selection: { dataset: "aacr" },
    models: {},
    judge: judge.description,
  };
  await writeSummary(
    runDir,
    info,
    ids.map((id) => instance(id)),
    results,
    judge,
    runDir,
  );
  writeFileSync(join(runDir, "run.json"), JSON.stringify({ info, ids }));
  return runDir;
}

async function cli(argv: string[]): Promise<{ code: number; text: string }> {
  let text = "";
  const out = { write: (chunk: string) => (text += chunk) };
  return { code: await main(argv, out, out), text };
}

describe("a run resumed on another ocra commit", () => {
  it("keeps each PR's build, and compare refuses it unless told to go ahead", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "ocra-mixed-"));
    dirs.push(scratch);
    const baseline = await reviewed(scratch, "baseline", [{ commit: A, ids: ["x@1", "y@1"] }]);
    const resumed = await reviewed(scratch, "resumed", [
      { commit: A, ids: ["x@1"] },
      { commit: B, ids: ["x@1", "y@1"] },
    ]);
    const result = (id: string) =>
      JSON.parse(readFileSync(join(resumed, "instances", `${id}.json`), "utf8"));
    expect(result("x@1")).toMatchObject({ ranOn: { ocra: { commit: A } } });
    expect(result("y@1")).toMatchObject({ ranOn: { ocra: { commit: B } } });

    const refused = await cli(["compare", baseline, resumed]);
    expect(refused.code).toBe(2);
    expect(refused.text).toContain(
      `${resumed}: its reviews were made with different ocra builds: 0.7.0 at aaaaaaaaaaaa, 30 steps per review agent vs 0.7.0 at bbbbbbbbbbbb, 30 steps per review agent`,
    );
    expect(refused.text).toContain("pass --allow-mixed to compare anyway");

    const allowed = await cli(["compare", baseline, resumed, "--allow-mixed"]);
    expect(allowed.code).toBe(0);
    expect(allowed.text).toContain(
      `Warning: ${resumed}: its reviews were made with different ocra builds`,
    );
  });

  it("compares two runs each made on one commit", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "ocra-mixed-"));
    dirs.push(scratch);
    const baseline = await reviewed(scratch, "baseline", [{ commit: A, ids: ["x@1"] }]);
    const change = await reviewed(scratch, "change", [{ commit: B, ids: ["x@1"] }]);
    const compared = await cli(["compare", baseline, change]);
    expect(compared.code).toBe(0);
    expect(compared.text).not.toContain("ocra builds");
    // The summary keeps what the reviews ran on, the models from their reports.
    const { summary } = JSON.parse(readFileSync(join(change, "summary.json"), "utf8"));
    expect(summary.provenance).toMatchObject({
      ocra: [{ commit: B }],
      runtime: ["opencode"],
      opencode: [{ version: "1.18.32" }],
      agents: [{ correctness: { tier: "standard", models: ["anthropic/claude-haiku-5-5"] } }],
      catalog: [{ "anthropic/claude-haiku-5-5": { cost: { input: 1, output: 5 } } }],
    });
  });
});

describe("run files", () => {
  it("are refused in a format this ocra-eval does not know", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "ocra-mixed-"));
    dirs.push(scratch);
    const baseline = await reviewed(scratch, "baseline", [{ commit: A, ids: ["x@1"] }]);
    const later = await reviewed(scratch, "later", [{ commit: A, ids: ["x@1"] }]);
    const path = join(later, "summary.json");
    writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, "utf8")), version: 99 }));
    const compared = await cli(["compare", baseline, later]);
    expect(compared.code).toBe(2);
    expect(compared.text).toContain(`${path} has format version 99`);
  });
});

describe("comparisonWarnings", () => {
  it("names runs that read different AACR-Bench files", () => {
    const run = (sha256?: string) =>
      ({
        info: {
          judge: "j",
          selection: { dataset: "aacr" },
          ...(sha256 ? { datasetFile: { sha256 } } : {}),
        },
        summary: { instances: { reviewed: 1 } },
      }) as unknown as SavedSummary;
    expect(comparisonWarnings([run("s1"), run("s1"), run()])).toEqual([]);
    expect(comparisonWarnings([run("s1"), run("s2")])).toEqual([
      "the runs read different AACR-Bench files (info.datasetFile)",
    ]);
  });
});
