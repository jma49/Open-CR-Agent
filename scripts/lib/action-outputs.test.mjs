import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  collectOutputs,
  formatOutputs,
  recordSessions,
  reportOutputs,
  SESSIONS_DIR,
  sessionOfRun,
} from "./action-outputs.mjs";

const report = {
  version: 1,
  runId: "20261003T120005Z-a1b2c3",
  verdict: "significant_concerns",
  findings: [{ title: "a" }, { title: "b" }],
};

/**
 * @param {string} root
 * @param {Record<string, string | undefined>} sessions
 */
function addSessions(root, sessions) {
  for (const [id, content] of Object.entries(sessions)) {
    const dir = join(root, SESSIONS_DIR, id);
    mkdirSync(dir, { recursive: true });
    if (content !== undefined) writeFileSync(join(dir, "report.json"), content);
  }
}

/** @param {Record<string, string | undefined>} [sessions] */
function checkout(sessions = {}) {
  const root = mkdtempSync(join(tmpdir(), "ocra-action-outputs-"));
  addSessions(root, sessions);
  return root;
}

/**
 * The outputs after a run that added `added` to the checkout's sessions.
 * @param {string} root
 * @param {Record<string, string | undefined>} added
 * @param {Record<string, string>} [extra]
 */
function afterRun(root, added, extra = {}) {
  const temp = mkdtempSync(join(tmpdir(), "ocra-runner-temp-"));
  const env = { RUNNER_TEMP: temp, ...extra };
  recordSessions({ env, root });
  addSessions(root, added);
  return { ...collectOutputs({ env, root }), temp };
}

describe("sessionOfRun", () => {
  it("is the one run id that was not there before, whatever its time", () => {
    const before = ["20991231T235959Z-ffffff", "20261003T110000Z-000000"];
    const after = [...before, ".gitignore", "20261003T120005Z-a1b2c3"];
    expect(sessionOfRun(before, after)).toBe("20261003T120005Z-a1b2c3");
  });

  it("is none when the run added no session, or more than one", () => {
    expect(sessionOfRun(["20261003T110000Z-000000"], ["20261003T110000Z-000000"])).toBeUndefined();
    expect(sessionOfRun([], ["20261003T120005Z-a1b2c3", "20261003T120006Z-a1b2c4"])).toBe(
      undefined,
    );
    expect(sessionOfRun([], ["not-a-run"])).toBeUndefined();
  });
});

describe("reportOutputs", () => {
  it("leaves the verdict out of a review that did not complete", () => {
    // A run whose every task failed still writes a report reading "approved".
    const report = { runId: "20261004T030435Z-fc396a", verdict: "approved", findings: [] };
    for (const code of ["2", "3"]) {
      expect(reportOutputs(report, code).map(([name]) => name)).toEqual(["run-id", "findings"]);
    }
    expect(reportOutputs(report, "1")).toContainEqual(["verdict", "approved"]);
    expect(reportOutputs(report, "0")).toContainEqual(["verdict", "approved"]);
  });

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
  it("copies the report of the session this run added to the runner's temporary directory", () => {
    const root = checkout({
      "20261003T110000Z-000000": JSON.stringify({ runId: "old", verdict: "approved" }),
      "20991231T235959Z-ffffff": JSON.stringify({ runId: "planted", verdict: "approved" }),
    });
    const r = afterRun(root, { [report.runId]: JSON.stringify(report) }, { OCRA_EXIT_CODE: "1" });
    const copy = join(r.temp, "ocra", "report.json");
    expect(r.warnings).toEqual([]);
    expect(Object.fromEntries(r.pairs)).toEqual({
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
    const root = checkout({ "20991231T235959Z-ffffff": JSON.stringify(report) });
    const r = afterRun(root, { "20261003T120005Z-a1b2c3": undefined }, { OCRA_EXIT_CODE: "2" });
    expect(r.pairs).toEqual([["exit-code", "2"]]);
    expect(r.warnings).toEqual([expect.stringContaining("wrote no report")]);
  });

  it("reads no report when it does not know which sessions were there before", () => {
    const root = checkout({ [report.runId]: JSON.stringify(report) });
    const temp = mkdtempSync(join(tmpdir(), "ocra-runner-temp-"));
    const { pairs, warnings } = collectOutputs({ env: { RUNNER_TEMP: temp }, root });
    expect(pairs).toEqual([]);
    expect(warnings).toEqual([expect.stringContaining("which session")]);
  });

  it("warns instead of failing on a report it cannot parse", () => {
    const r = afterRun(checkout(), { [report.runId]: "{" }, { OCRA_EXIT_CODE: "3" });
    expect(r.pairs).toEqual([["exit-code", "3"]]);
    expect(r.warnings).toEqual([expect.stringContaining("could not read")]);
  });

  it("refuses a report that is a link", () => {
    const root = checkout();
    const outside = join(root, "outside.json");
    writeFileSync(outside, JSON.stringify(report));
    const temp = mkdtempSync(join(tmpdir(), "ocra-runner-temp-"));
    const env = { RUNNER_TEMP: temp };
    recordSessions({ env, root });
    mkdirSync(join(root, SESSIONS_DIR, report.runId), { recursive: true });
    symlinkSync(outside, join(root, SESSIONS_DIR, report.runId, "report.json"));
    const { pairs, warnings } = collectOutputs({ env, root });
    expect(pairs).toEqual([]);
    expect(warnings).toEqual([expect.stringContaining("symbolic link")]);
  });

  it("refuses a sessions directory that is a link", () => {
    const root = checkout();
    const elsewhere = checkout({ [report.runId]: JSON.stringify(report) });
    mkdirSync(join(root, ".ocra"));
    symlinkSync(join(elsewhere, SESSIONS_DIR), join(root, SESSIONS_DIR), "junction");
    const temp = mkdtempSync(join(tmpdir(), "ocra-runner-temp-"));
    const env = { RUNNER_TEMP: temp };
    expect(() => recordSessions({ env, root })).toThrow(/symbolic link/);
    const { pairs, warnings } = collectOutputs({ env, root });
    expect(pairs).toEqual([]);
    expect(warnings).toEqual([expect.stringContaining("which session")]);
  });
});
