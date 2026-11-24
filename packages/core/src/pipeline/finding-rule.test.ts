import { describe, expect, it } from "vitest";
import { finding, runtime, twoFiles, vcs } from "./run.fakes.js";
import { review } from "./run.js";

const files = {
  ".ocra/rules.json": JSON.stringify({
    rules: [{ id: "tenant", path: "src/**", rule: "Check tenant ids." }],
  }),
};

const citing = (rule: string) =>
  runtime(async function* (spec) {
    yield {
      type: "finding",
      taskId: spec.taskId,
      finding: { ...finding("src/a.ts", "const a = 1;"), rule },
    };
    yield { type: "done", taskId: spec.taskId };
  });

describe("the rule a finding applies", () => {
  it("is named by the id the prompt gave the rule", async () => {
    const rt = citing("tenant");
    const report = await review({ vcs: vcs(files, twoFiles), runtime: rt });
    expect(rt.specs[0]?.userPrompt).toContain("Rule tenant:\nCheck tenant ids.");
    expect(report.findings[0]?.rule).toEqual({ kind: "rule", id: "tenant" });
  });

  it("is left out when the task was not given that rule", async () => {
    const report = await review({
      vcs: vcs(files, twoFiles),
      runtime: citing("tenant"),
      mode: { without: ["rules"] },
    });
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]).not.toHaveProperty("rule");
  });
});
