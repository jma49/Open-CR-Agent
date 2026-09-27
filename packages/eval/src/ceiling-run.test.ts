import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { measureCeiling } from "./ceiling-run.js";
import type { Instance } from "./dataset.js";
import { defaultOcraCommand } from "./reviewer.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("measureCeiling", () => {
  it("classifies a PR's annotations with the real CLI and no model", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ocra-ceiling-"));
    dirs.push(dir);
    const git = (...args: string[]) =>
      execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
    git("init", "-q", "-b", "main");
    git("config", "user.email", "t@example.com");
    git("config", "user.name", "T");
    writeFileSync(join(dir, "app.ts"), "export const a = 1;\n");
    git("add", "-A");
    git("commit", "-q", "-m", "base");
    const base = git("rev-parse", "HEAD");
    writeFileSync(join(dir, "app.ts"), "export const a = 1;\nexport const b = 2;\n");
    writeFileSync(join(dir, "package-lock.json"), "{}\n");
    git("add", "-A");
    git("commit", "-q", "-m", "head");
    const head = git("rev-parse", "HEAD");

    const note = { side: "right" as const, note: "n", context: "Diff Level", toLine: null };
    const instance: Instance = {
      id: "local@1",
      repo: "local/repo",
      prUrl: "https://github.com/local/repo/pull/1",
      language: "TypeScript",
      prCategory: "Feature",
      baseCommit: base,
      headCommit: head,
      changeLines: 2,
      references: [
        { ...note, path: "app.ts", fromLine: 2, category: "Code Defect" },
        { ...note, path: "package-lock.json", fromLine: 1, category: "Code Defect" },
      ],
    };
    const logs: string[] = [];
    const markdown = await measureCeiling([instance], {
      outDir: join(dir, "out"),
      reposDir: dir,
      command: defaultOcraCommand(),
      prepare: async () => dir,
      log: (m) => logs.push(m),
    });
    expect(logs).toEqual(["[1/1] local@1: 2 issue(s) classified"]);
    expect(markdown).toContain("| Reachable | 1 | 50.0% |");
    expect(markdown).toContain("Excluded files by reason: generated 1");
  });
});
