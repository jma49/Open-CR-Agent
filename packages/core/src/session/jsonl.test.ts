import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ReviewReport } from "../pipeline/report.js";
import { newRunId } from "../pipeline/run-id.js";
import { EVENTS_FILE, JsonlSessionWriter, REPORT_FILE } from "./jsonl.js";

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
    writer.write({ type: "run_started", runId: "20261002T070000Z-abcdef", changeRequest });
    const report = { changeRequest, findings: [] } as unknown as ReviewReport;
    writer.write({ type: "run_finished", report });

    const lines = readFileSync(join(root, "s1", EVENTS_FILE), "utf8")
      .trim()
      .split("\n");
    expect(lines.map((l) => JSON.parse(l).type)).toEqual(["run_started", "run_finished"]);
    expect(JSON.parse(lines[0] as string).time).toMatch(/^\d{4}-/);
    expect(JSON.parse(readFileSync(join(root, "s1", REPORT_FILE), "utf8"))).toMatchObject({
      version: 1,
      changeRequest,
      findings: [],
    });
  });

  it("ignores every file in the sessions directory for git", () => {
    const root = mkdtempSync(join(tmpdir(), "ocra-session-"));
    dirs.push(root);
    new JsonlSessionWriter(root, "s1");
    expect(readFileSync(join(root, ".gitignore"), "utf8")).toBe("*\n");
  });

  it("refuses sessions directories reached through a symbolic link", () => {
    const root = mkdtempSync(join(tmpdir(), "ocra-session-"));
    const elsewhere = mkdtempSync(join(tmpdir(), "ocra-elsewhere-"));
    dirs.push(root, elsewhere);
    mkdirSync(join(root, ".ocra"));
    symlinkSync(elsewhere, join(root, ".ocra", "sessions"));
    expect(() => new JsonlSessionWriter(join(root, ".ocra", "sessions"), "s1")).toThrow(
      "symbolic link",
    );
    symlinkSync(elsewhere, join(root, "linked-ocra"));
    expect(() => new JsonlSessionWriter(join(root, "linked-ocra", "sessions"), "s1")).toThrow(
      "symbolic link",
    );
    expect(existsSync(join(elsewhere, "s1"))).toBe(false);
  });

  it("never writes the .gitignore through a link and replaces other content", () => {
    const root = mkdtempSync(join(tmpdir(), "ocra-session-"));
    const elsewhere = mkdtempSync(join(tmpdir(), "ocra-elsewhere-"));
    dirs.push(root, elsewhere);
    mkdirSync(root, { recursive: true });
    symlinkSync(join(elsewhere, "planted"), join(root, ".gitignore"));
    expect(() => new JsonlSessionWriter(root, "s1")).toThrow();
    expect(existsSync(join(elsewhere, "planted"))).toBe(false);

    const other = mkdtempSync(join(tmpdir(), "ocra-session-"));
    dirs.push(other);
    writeFileSync(join(other, ".gitignore"), "!*\n");
    new JsonlSessionWriter(other, "s1");
    expect(readFileSync(join(other, ".gitignore"), "utf8")).toBe("*\n");
  });

  it("escapes control and bidirectional characters in the files it writes", () => {
    const root = mkdtempSync(join(tmpdir(), "ocra-session-"));
    dirs.push(root);
    const writer = new JsonlSessionWriter(root, "s1");
    const changeRequest = {
      id: "1",
      title: "a\u009b2J\u202eb",
      description: "",
      baseSha: "b",
      headSha: "h",
    };
    writer.write({ type: "run_started", runId: "20261002T070000Z-abcdef", changeRequest });
    writer.write({
      type: "run_finished",
      report: { changeRequest, findings: [] } as unknown as ReviewReport,
    });
    for (const file of [EVENTS_FILE, REPORT_FILE]) {
      const text = readFileSync(join(root, "s1", file), "utf8");
      expect(text).not.toMatch(/[\u009b\u202e]/);
      expect(text).toContain("\\u009b");
    }
    const [line] = readFileSync(join(root, "s1", EVENTS_FILE), "utf8").split("\n");
    expect(JSON.parse(line as string).changeRequest.title).toBe("a\u009b2J\u202eb");
  });

  it("creates sortable, unique session ids", () => {
    const id = newRunId(new Date("2026-09-24T21:40:55.123Z"));
    expect(id).toMatch(/^20260924T214055Z-[0-9a-f]{6}$/);
    expect(newRunId()).not.toBe(newRunId());
  });
});
