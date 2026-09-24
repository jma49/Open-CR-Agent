import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ReviewReport } from "../pipeline/report.js";
import { EVENTS_FILE, JsonlSessionWriter, newSessionId, REPORT_FILE } from "./jsonl.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("JsonlSessionWriter", () => {
  it("appends one JSON event per line and writes the final report", () => {
    const root = mkdtempSync(join(tmpdir(), "ocra-session-"));
    dirs.push(root);
    const writer = new JsonlSessionWriter(root, "s1");
    const changeRequest = { id: "1", title: "t", description: "", baseSha: "b", headSha: "h" };
    writer.write({ type: "run_started", changeRequest });
    const report = { changeRequest, findings: [] } as unknown as ReviewReport;
    writer.write({ type: "run_finished", report });

    const lines = readFileSync(join(root, "s1", EVENTS_FILE), "utf8")
      .trim()
      .split("\n");
    expect(lines.map((l) => JSON.parse(l).type)).toEqual(["run_started", "run_finished"]);
    expect(JSON.parse(lines[0] as string).time).toMatch(/^\d{4}-/);
    expect(JSON.parse(readFileSync(join(root, "s1", REPORT_FILE), "utf8"))).toEqual(report);
  });

  it("creates sortable, unique session ids", () => {
    const id = newSessionId(new Date("2026-09-24T21:40:55.123Z"));
    expect(id).toMatch(/^20260924T214055Z-[0-9a-f]{6}$/);
    expect(newSessionId()).not.toBe(newSessionId());
  });
});
