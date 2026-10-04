import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  collectOutputs,
  formatOutputs,
  newestSession,
  reportOutputs,
  runStamp,
  SESSIONS_DIR,
} from "./action-outputs.mjs";

const report = {
  version: 1,
  runId: "20261003T120005Z-a1b2c3",
  verdict: "significant_concerns",
  findings: [{ title: "a" }, { title: "b" }],
};

function checkout(sessions = {}) {
  const root = mkdtempSync(join(tmpdir(), "ocra-action-outputs-"));
  for (const [id, content] of Object.entries(sessions)) {
    const dir = join(root, SESSIONS_DIR, id);
    mkdirSync(dir, { recursive: true });
    if (content !== undefined) writeFileSync(join(dir, "report.json"), content);
  }
  return root;
}

describe("runStamp", () => {
  it("is the prefix of a run id started in that second", () => {
    expect(runStamp(new Date("2026-10-03T12:00:05.678Z"))).toBe("20261003T120005Z");
  });
});

describe("newestSession", () => {
  it("takes the newest run that started at or after the stamp", () => {
    const names = [
      ".gitignore",
      "20261003T115959Z-000000",
      "20261003T120005Z-ffffff",
      "20261003T120010Z-abcdef",
    ];
    expect(newestSession(names, "20261003T120005Z")).toBe("20261003T120010Z-abcdef");
  });

  it("ignores runs of earlier steps and names that are not run ids", () => {
    expect(newestSession(["20261003T115959Z-000000", "zzz"], "20261003T120005Z")).toBeUndefined();
  });
});

describe("reportOutputs", () => {
  it("gives the run id, the verdict and the number of findings", () => {
    expect(reportOutputs(report)).toEqual([
      ["run-id", "20261003T120005Z-a1b2c3"],
      ["verdict", "significant_concerns"],
      ["findings", "2"],
    ]);
  });

  it("leaves out what the report does not carry", () => {
    expect(reportOutputs({ verdict: "approved" })).toEqual([["verdict", "approved"]]);
  });
});

describe("formatOutputs", () => {
  it("writes one name=value line each", () => {
    expect(
      formatOutputs([
        ["verdict", "approved"],
        ["findings", "0"],
      ]),
    ).toBe("verdict=approved\nfindings=0\n");
  });

  it("refuses a value that would set another output", () => {
    expect(() => formatOutputs([["verdict", "approved\nexit-code=0"]])).toThrow(/line break/);
  });
});

describe("collectOutputs", () => {
  it("copies this run's report to the runner's temporary directory", () => {
    const root = checkout({
      "20261003T110000Z-000000": JSON.stringify({
        runId: "old",
        verdict: "approved",
        findings: [],
      }),
      [report.runId]: JSON.stringify(report),
    });
    const temp = mkdtempSync(join(tmpdir(), "ocra-runner-temp-"));
    const env = { OCRA_EXIT_CODE: "1", OCRA_STARTED: "20261003T120005Z", RUNNER_TEMP: temp };
    const { pairs, warnings } = collectOutputs({ env, root });
    const copy = join(temp, "ocra", "report.json");
    expect(warnings).toEqual([]);
    expect(Object.fromEntries(pairs)).toEqual({
      "exit-code": "1",
      "run-id": report.runId,
      verdict: "significant_concerns",
      findings: "2",
      report: copy,
    });
    expect(JSON.parse(readFileSync(copy, "utf8"))).toEqual(report);
  });

  it("names the SARIF log only when ocra wrote it", () => {
    const root = checkout();
    const sarif = join(root, "ocra.sarif");
    const env = { OCRA_EXIT_CODE: "0", OCRA_SARIF_FILE: sarif };
    expect(collectOutputs({ env, root }).pairs).not.toContainEqual(["sarif", sarif]);
    writeFileSync(sarif, "{}");
    expect(collectOutputs({ env, root }).pairs).toContainEqual(["sarif", sarif]);
  });

  it("keeps the exit code and warns when the run wrote no report", () => {
    const root = checkout({ "20261003T120005Z-a1b2c3": undefined });
    const env = { OCRA_EXIT_CODE: "2", OCRA_STARTED: "20261003T120005Z" };
    const { pairs, warnings } = collectOutputs({ env, root });
    expect(pairs).toEqual([["exit-code", "2"]]);
    expect(warnings).toEqual([expect.stringContaining("wrote no report")]);
  });

  it("warns instead of failing on a report it cannot parse", () => {
    const root = checkout({ "20261003T120005Z-a1b2c3": "{" });
    const env = { OCRA_EXIT_CODE: "3", OCRA_STARTED: "20261003T120005Z", RUNNER_TEMP: root };
    const { pairs, warnings } = collectOutputs({ env, root });
    expect(pairs).toEqual([["exit-code", "3"]]);
    expect(warnings).toEqual([expect.stringContaining("could not read")]);
  });
});
