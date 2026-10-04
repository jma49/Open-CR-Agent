import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { exec } from "./exec.js";
import type { Instance } from "./instance.js";
import { defaultOcraCommand, reviewInstance } from "./reviewer.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("defaultOcraCommand", () => {
  it("points at the built ocra CLI", () => {
    const [node, main] = defaultOcraCommand();
    expect(node).toBe(process.execPath);
    expect(main).toBe(fileURLToPath(new URL("../../cli/dist/main.js", import.meta.url)));
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

  it("runs with ocra Cloud off, so a signed-in account never shapes or receives a benchmark run", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ocra-eval-env-"));
    dirs.push(dir);
    const script = join(dir, "record.mjs");
    writeFileSync(
      script,
      'import { writeFileSync } from "node:fs"; writeFileSync("env.json", JSON.stringify({ cloud: process.env.OCRA_CLOUD ?? null }));\n',
    );
    const instance = { baseCommit: "a".repeat(40), headCommit: "b".repeat(40) } as Instance;
    await reviewInstance(dir, instance, join(dir, "out.json"), {
      command: [process.execPath, script],
      timeoutMs: 30_000,
    });
    expect(JSON.parse(readFileSync(join(dir, "env.json"), "utf8"))).toEqual({ cloud: "off" });
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
