import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { capture, deps, removeRepos, repoWithChange, type Script } from "../../run.fakes.js";
import { run } from "../../run.js";

afterEach(removeRepos);

function scan(cwd: string): void {
  writeFileSync(
    join(cwd, "scan.sarif"),
    JSON.stringify({
      version: "2.1.0",
      runs: [
        {
          tool: { driver: { name: "Semgrep OSS", semanticVersion: "1.178.0" } },
          results: [
            {
              ruleId: "negative-retries",
              level: "note",
              message: { text: "A negative retry count disables retries." },
              locations: [
                {
                  physicalLocation: {
                    artifactLocation: { uri: "app.ts", uriBaseId: "%SRCROOT%" },
                    region: { startLine: 2, snippet: { text: "export const retries = -1;" } },
                  },
                },
              ],
            },
          ],
        },
      ],
    }),
  );
}

const clean: Script = async function* (spec) {
  yield { type: "done", taskId: spec.taskId };
};

describe("ocra review --import-sarif", () => {
  it("imports an analyzer's SARIF results that fall on the change", async () => {
    const cwd = repoWithChange();
    scan(cwd);
    const out = capture();
    expect(
      await run(
        ["review", "--import-sarif", "scan.sarif", "--format", "json"],
        out,
        capture(),
        deps(cwd, clean),
      ),
    ).toBe(0);
    const report = JSON.parse(out.text());
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]).toMatchObject({
      reviewer: "semgrep-oss",
      severity: "suggestion",
      file: "app.ts",
      lines: { start: 2, end: 2 },
      provenance: { task: "sarif-semgrep-oss-1" },
    });
    expect(report.tasks.map((t: { taskId: string }) => t.taskId)).toContain("sarif-semgrep-oss-1");

    const err = capture();
    expect(
      await run(["review", "--import-sarif", "missing.sarif"], capture(), err, deps(cwd, clean)),
    ).toBe(2);
    expect(err.text()).toContain("--import-sarif missing.sarif");
  });
});

describe("ocra review --sarif-evidence", () => {
  it("shows the reviewers the log's results, imports none, and plans with them", async () => {
    const cwd = repoWithChange();
    scan(cwd);
    const seen: string[] = [];
    const recording: Script = async function* (spec) {
      seen.push(spec.userPrompt);
      yield { type: "done", taskId: spec.taskId };
    };
    const out = capture();
    expect(
      await run(
        ["review", "--sarif-evidence", "scan.sarif", "--format", "json"],
        out,
        capture(),
        deps(cwd, recording),
      ),
    ).toBe(0);
    const report = JSON.parse(out.text());
    expect(report.findings).toEqual([]);
    expect(report.analyzerEvidence).toMatchObject([{ tool: "Semgrep OSS", results: 1 }]);
    expect(seen.join("\n")).toContain("Semgrep OSS negative-retries (suggestion, on the change)");

    const plan = capture();
    expect(
      await run(
        ["review", "--plan", "--sarif-evidence", "scan.sarif"],
        plan,
        capture(),
        deps(cwd, recording),
      ),
    ).toBe(0);

    const err = capture();
    expect(
      await run(["review", "--sarif-evidence", "missing.sarif"], capture(), err, deps(cwd, clean)),
    ).toBe(2);
    expect(err.text()).toContain("--sarif-evidence missing.sarif");
  });
});
