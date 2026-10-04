import { describe, expect, it } from "vitest";
import { parseSarifLog } from "../sarif/schema.js";
import { runtime, twoFiles, vcs } from "./run.fakes.js";
import { review } from "./run.js";

describe("review with SARIF logs", () => {
  it("imports an analyzer's SARIF results on the change as findings of their own task", async () => {
    const rt = runtime(async function* (spec) {
      yield { type: "done", taskId: spec.taskId };
    });
    const log = parseSarifLog(
      JSON.stringify({
        version: "2.1.0",
        runs: [
          {
            tool: { driver: { name: "Semgrep OSS", semanticVersion: "1.178.0" } },
            results: [
              {
                ruleId: "no-b",
                level: "warning",
                message: { text: "b is set." },
                locations: [
                  {
                    physicalLocation: {
                      artifactLocation: { uri: "src/b.ts", uriBaseId: "%SRCROOT%" },
                      region: { startLine: 2, snippet: { text: "const b = 2;" } },
                    },
                  },
                ],
              },
              {
                ruleId: "no-b",
                message: { text: "elsewhere" },
                locations: [
                  {
                    physicalLocation: {
                      artifactLocation: { uri: "src/a.ts" },
                      region: { startLine: 9 },
                    },
                  },
                ],
              },
            ],
          },
        ],
      }),
    );
    const report = await review({
      vcs: vcs({ "src/b.ts": "keep\nconst b = 2;\n" }, twoFiles),
      runtime: rt,
      sarif: [log],
      stages: { verify: false, judge: false },
    });
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]).toMatchObject({
      reviewer: "semgrep-oss",
      file: "src/b.ts",
      lineRange: { start: 2, end: 2 },
      provenance: { task: "sarif-semgrep-oss-1" },
      verification: "unchecked",
    });
    expect(report.tasks.map((t) => t.taskId)).toEqual(["correctness-1", "sarif-semgrep-oss-1"]);
    expect(report.tasks[1]?.usage.costUsd).toBe(0);
    expect(report.warnings).toContain(
      "Semgrep OSS: imported 1 result(s); left out 1 outside the change",
    );
    expect(report.verdict).not.toBe("approved");
  });
});
