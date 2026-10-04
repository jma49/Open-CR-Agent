import { execFileSync } from "node:child_process";
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
import { dirname, join } from "node:path";
import type { OutputFinding, ReportOutput } from "@open-cr-agent/core";
import { afterEach, describe, expect, it } from "vitest";
import { memoryCommand } from "./memory.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function capture() {
  let text = "";
  return { write: (chunk: string) => (text += chunk), text: () => text };
}

function repoWithSession(): string {
  const dir = mkdtempSync(join(tmpdir(), "ocra-memory-"));
  dirs.push(dir);
  execFileSync("git", ["init", "-q"], { cwd: dir });
  const session = join(dir, ".ocra", "sessions", "20260926T000000Z-aaaaaa");
  mkdirSync(session, { recursive: true });
  const finding = (fingerprint: string, title: string): OutputFinding => ({
    fingerprint,
    reviewer: "correctness",
    category: "bug",
    severity: "warning",
    verification: "unchecked",
    file: "src/a.ts",
    inDiff: true,
    status: "new",
    title,
    body: "",
    evidence: [],
    code: "",
  });
  const report: ReportOutput = {
    version: 1,
    changeRequest: { id: "1", title: "t", description: "", baseSha: "b", headSha: "h" },
    tier: "lite",
    verdict: "minor_issues",
    summary: "",
    coverage: [],
    findings: [
      finding("abcdef0123456789", "Unbounded retry"),
      finding("abcd990000000000", "Other"),
    ],
    unverifiedCriticals: 0,
    refuted: [],
    remembered: [],
    tasks: [],
    skipped: [],
    bundles: [],
    usage: { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cachedTokens: 0, costUsd: 0 },
    warnings: [],
  };
  writeFileSync(join(session, "report.json"), JSON.stringify(report));
  return dir;
}

describe("ocra memory", () => {
  it("remembers a finding from the newest session and lists it", async () => {
    const dir = repoWithSession();
    const out = capture();
    const at = new Date("2026-09-26T12:00:00Z");
    await memoryCommand(
      ["add", "abcdef", "--reason", "Retries are capped by the gateway."],
      out,
      dir,
      at,
    );
    expect(out.text()).toContain("Remembered abcdef01: Unbounded retry");
    expect(JSON.parse(readFileSync(join(dir, ".ocra", "memory.json"), "utf8"))).toEqual({
      accepted: [
        {
          fingerprint: "abcdef0123456789",
          file: "src/a.ts",
          title: "Unbounded retry",
          reason: "Retries are capped by the gateway.",
          added: "2026-09-26",
        },
      ],
    });

    const again = capture();
    await memoryCommand(["add", "abcdef", "--reason", "x"], again, dir, at);
    expect(again.text()).toContain("Already remembered");

    const list = capture();
    await memoryCommand(["list"], list, dir);
    expect(list.text()).toContain("abcdef01  src/a.ts  Unbounded retry");
  });

  it("never writes memory.json through a planted symbolic link", async () => {
    const dir = repoWithSession();
    const outside = join(mkdtempSync(join(tmpdir(), "ocra-outside-")), "target.json");
    dirs.push(dirname(outside));
    symlinkSync(outside, join(dir, ".ocra", "memory.json"));
    await expect(
      memoryCommand(["add", "abcdef", "--reason", "r"], capture(), dir, new Date()),
    ).rejects.toThrow("symbolic link");
    expect(existsSync(outside)).toBe(false);
  });

  it("skips newer sessions that have no report", async () => {
    const dir = repoWithSession();
    mkdirSync(join(dir, ".ocra", "sessions", "20991231T000000Z-bbbbbb"), { recursive: true });
    const out = capture();
    await memoryCommand(["add", "abcdef", "--reason", "r"], out, dir);
    expect(out.text()).toContain("Remembered abcdef01");
  });

  it("asks for a unique id and a reason", async () => {
    const dir = repoWithSession();
    await expect(memoryCommand(["add", "abcd", "--reason", "r"], capture(), dir)).rejects.toThrow(
      "at least 6",
    );
    await expect(memoryCommand(["add", "abcdef"], capture(), dir)).rejects.toThrow("--reason");
    await expect(memoryCommand(["add", "ffffff", "--reason", "r"], capture(), dir)).rejects.toThrow(
      "No finding ffffff",
    );
  });

  it("says why a session's report cannot be read", async () => {
    const dir = repoWithSession();
    const session = join(dir, ".ocra", "sessions", "20260926T000000Z-aaaaaa");
    writeFileSync(join(session, "report.json"), JSON.stringify({ findings: [] }));
    await expect(memoryCommand(["add", "abcdef", "--reason", "r"], capture(), dir)).rejects.toThrow(
      "is not a version 1 ocra report",
    );
  });
});
