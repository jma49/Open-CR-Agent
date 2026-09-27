import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Instance } from "./dataset.js";
import { exec } from "./exec.js";
import { defaultOcraCommand, reviewInstance } from "./reviewer.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("defaultOcraCommand", () => {
  it("points at the built ocra CLI", () => {
    const [node, main] = defaultOcraCommand();
    expect(node).toBe(process.execPath);
    expect(main).toMatch(/cli[/\\]dist[/\\]main\.js$/);
    expect(existsSync(main as string)).toBe(true);
  });
});

describe("reviewInstance", () => {
  it("never lets a benchmark repository's config load plugins", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ocra-eval-argv-"));
    dirs.push(dir);
    const script = join(dir, "record.mjs");
    writeFileSync(
      script,
      'import { writeFileSync } from "node:fs"; writeFileSync("argv.json", JSON.stringify(process.argv.slice(2)));\n',
    );
    const instance = { baseCommit: "a".repeat(40), headCommit: "b".repeat(40) } as Instance;
    await reviewInstance(dir, instance, join(dir, "out.json"), {
      command: [process.execPath, script],
      timeoutMs: 30_000,
    });
    const argv = JSON.parse(readFileSync(join(dir, "argv.json"), "utf8")) as string[];
    expect(argv.slice(0, 1)).toEqual(["review"]);
    expect(argv).toContain("--no-repo-config");
  });
});

describe("exec", () => {
  it("kills a command that ignores the timeout's SIGTERM", async () => {
    const started = Date.now();
    const result = await exec(
      process.execPath,
      ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"],
      { timeoutMs: 100, killGraceMs: 200 },
    );
    expect(result.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});
