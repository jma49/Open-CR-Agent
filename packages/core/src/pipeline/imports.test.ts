import { describe, expect, it } from "vitest";
import { parseUnifiedDiff } from "../diff/parse.js";
import type { ReviewEvent } from "../report/report.js";
import { parseSarifLog } from "../sarif/schema.js";
import { importSarif, MAX_IMPORTED_PER_RUN } from "./imports.js";
import { patch } from "./run.fakes.js";

// patch() changes line 2 of the file; the hunk covers lines 1 and 2.
const selected = parseUnifiedDiff(
  [
    patch("src/a.ts", "const a = 1;"),
    patch("src/b.ts", "const b = 2;"),
    patch("src/c.ts", "const c = 3;"),
  ].join("\n"),
);
const files: Record<string, string> = {
  "src/a.ts": "keep\nconst a = 1;\nthird\n",
  "src/b.ts": "keep\nconst b = 2;\n",
};
const context = {
  readFile: async (path: string) => files[path],
  readDiff: () => undefined,
  searchCode: async () => [],
};

function log(results: unknown[], name = "Semgrep OSS") {
  return parseSarifLog(
    JSON.stringify({ version: "2.1.0", runs: [{ tool: { driver: { name } }, results }] }),
  );
}

function result(uri: string, line: number, snippet?: string, level = "warning") {
  return {
    ruleId: "r1",
    level,
    message: { text: "Something is off." },
    locations: [
      {
        physicalLocation: {
          artifactLocation: { uri },
          region: { startLine: line, ...(snippet ? { snippet: { text: snippet } } : {}) },
        },
      },
    ],
  };
}

async function run(logs: ReturnType<typeof log>[]) {
  const events: ReviewEvent[] = [];
  const imported = await importSarif(logs, { selected, context }, (e) => events.push(e));
  return { ...imported, events };
}

describe("importSarif", () => {
  it("keeps results on the change as findings of a synthetic task, anchored like a model's", async () => {
    const { findings, outcomes, warnings, events } = await run([
      log([result("src/b.ts", 2, "const b = 2;"), result("src/a.ts", 3)]),
    ]);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      reviewer: "semgrep-oss",
      category: "semgrep-oss",
      file: "src/b.ts",
      existingCode: "const b = 2;",
      severity: "warning",
      lineRange: { start: 2, end: 2 },
      anchor: { method: "hunk", inDiff: true },
      provenance: { task: "sarif-semgrep-oss-1" },
      status: "new",
    });
    expect(findings[0]?.quote).toBeDefined();
    expect(outcomes).toEqual([
      expect.objectContaining({
        taskId: "sarif-semgrep-oss-1",
        reviewer: "semgrep-oss",
        bundle: "sarif",
        files: ["src/b.ts"],
        status: "completed",
        findings: 1,
        usage: expect.objectContaining({ costUsd: 0 }),
      }),
    ]);
    expect(warnings).toEqual(["Semgrep OSS: imported 1 result(s); left out 1 outside the change"]);
    expect(events.map((e) => e.type)).toEqual(["task_started", "finding", "task_finished"]);
  });

  it("quotes the file's lines when the log carries no snippet", async () => {
    const { findings } = await run([log([result("src/a.ts", 2)])]);
    expect(findings[0]?.existingCode).toBe("const a = 1;");
    expect(findings[0]?.anchor.method).toBe("hunk");
  });

  it("leaves out results on files the change does not touch, and counts what it skipped", async () => {
    const { findings, warnings } = await run([
      log([
        result("src/d.ts", 1),
        result("src/a.ts", 1, undefined, "note"),
        { ruleId: "r1", message: { text: "no lines" } },
      ]),
    ]);
    expect(findings.map((f) => f.severity)).toEqual(["suggestion"]);
    expect(warnings).toEqual([
      "Semgrep OSS: imported 1 result(s); left out 1 outside the change, 1 without a file and lines",
    ]);
  });

  it("numbers runs of the same tool across logs and caps each run", async () => {
    const many = Array.from({ length: MAX_IMPORTED_PER_RUN + 1 }, () =>
      result("src/a.ts", 2, "const a = 1;"),
    );
    const { findings, outcomes, warnings } = await run([
      log(many),
      log([result("src/b.ts", 2)], "Semgrep OSS"),
    ]);
    expect(outcomes.map((o) => o.taskId)).toEqual(["sarif-semgrep-oss-1", "sarif-semgrep-oss-2"]);
    expect(findings).toHaveLength(MAX_IMPORTED_PER_RUN + 1);
    expect(warnings[0]).toContain(`1 over the limit of ${MAX_IMPORTED_PER_RUN} per run`);
  });

  it("drops a result on the change whose lines cannot be read and has no snippet", async () => {
    // src/c.ts is in the diff but readFile has no content for it.
    const { findings, warnings } = await run([log([result("src/c.ts", 2)])]);
    expect(findings).toHaveLength(0);
    expect(warnings).toEqual([
      "Semgrep OSS: imported 0 result(s); left out 1 on lines that could not be read",
    ]);
  });
});
