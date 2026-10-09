import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { refuseLinkedOutput, writeOutputFile } from "./output-file.js";

// rename never settles while `hold` is set: the moment between the write of
// the temporary file and the rename that replaces the output with it.
const rename = vi.hoisted(() => ({ hold: false }));
vi.mock("node:fs/promises", async (original) => {
  const fs = await original<typeof import("node:fs/promises")>();
  return {
    ...fs,
    rename: (from: string, to: string) =>
      rename.hold ? new Promise<void>(() => {}) : fs.rename(from, to),
  };
});

const dirs: string[] = [];
afterEach(() => {
  rename.hold = false;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), "ocra-output-"));
  dirs.push(dir);
  return dir;
}

describe("writeOutputFile", () => {
  it("replaces the file and leaves nothing else", async () => {
    const dir = temp();
    await writeOutputFile(dir, join(dir, "report.json"), "{}\n");
    expect(readFileSync(join(dir, "report.json"), "utf8")).toBe("{}\n");
    expect(readdirSync(dir)).toEqual(["report.json"]);
  });

  it("leaves no temporary file when the process exits before the rename", async () => {
    const dir = temp();
    rename.hold = true;
    const before = new Set(process.listeners("exit"));
    void writeOutputFile(dir, join(dir, "report.json"), "{}\n");
    await vi.waitFor(() => expect(readdirSync(dir)).toHaveLength(1));
    const onExit = process.listeners("exit").filter((l) => !before.has(l));
    expect(onExit).toHaveLength(1);
    for (const listener of onExit) {
      listener(0);
      process.off("exit", listener);
    }
    expect(readdirSync(dir)).toEqual([]);
  });

  it("refuses an output that exists and is not a regular file", async () => {
    const dir = temp();
    mkdirSync(join(dir, "out"));
    await expect(refuseLinkedOutput(dir, join(dir, "out"))).rejects.toMatchObject({
      code: "ACCESS_DENIED",
      message: expect.stringContaining("not a regular file"),
    });
    if (process.platform !== "win32") {
      await expect(refuseLinkedOutput(dir, "/dev/null")).rejects.toMatchObject({
        code: "ACCESS_DENIED",
      });
    }
  });
});
