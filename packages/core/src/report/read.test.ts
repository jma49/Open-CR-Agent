import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { emptyUsage } from "../agent/usage.js";
import { isOcraError } from "../errors.js";
import { toReportOutput } from "./output.js";
import { readReport } from "./read.js";

const dir = mkdtempSync(join(tmpdir(), "ocra-read-report-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function file(name: string, content: string): string {
  const path = join(dir, name);
  writeFileSync(path, content);
  return path;
}

const report = toReportOutput({
  runId: "r",
  changeRequest: { id: "1", title: "t", description: "", baseSha: "b", headSha: "h" },
  tier: "lite",
  verdict: "approved",
  summary: "",
  coverage: [],
  bundles: [],
  tasks: [],
  skipped: [],
  findings: [],
  unverifiedCriticals: 0,
  refuted: [],
  remembered: [],
  usage: emptyUsage(),
  warnings: [],
});

describe("readReport", () => {
  it("reads a report ocra wrote", async () => {
    expect(await readReport(file("ok.json", JSON.stringify(report)))).toEqual(report);
  });

  it.each([
    ["missing", join(dir, "absent.json"), "cannot read"],
    ["not JSON", file("bad.json", "{"), "is not valid JSON"],
    ["another shape", file("other.json", JSON.stringify({ findings: [] })), "is not a version 1"],
    ["another version", file("v2.json", JSON.stringify({ ...report, version: 2 })), "version"],
  ])("rejects a report that is %s, saying why", async (_, path, why) => {
    const error = await readReport(path).catch((e: unknown) => e);
    expect(isOcraError(error, "INPUT_INVALID")).toBe(true);
    expect(String(error)).toContain(why);
  });
});
