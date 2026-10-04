import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { measureCeiling } from "./ceiling-run.js";
import type { Instance } from "./instance.js";
import { defaultOcraCommand } from "./reviewer.js";

// This test runs the real CLI as a black box, so it needs the build; tsc -b
// is incremental, so after a build it only checks that dist/ is current.
beforeAll(() => {
  const root = fileURLToPath(new URL("../../..", import.meta.url));
  execFileSync(process.execPath, [join(root, "node_modules/typescript/bin/tsc"), "-b"], {
    cwd: root,
  });
}, 120_000);

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
    // Benchmark repositories are third-party code: a plugin in their config
    // must never run on the maintainer's machine.
    const marker = join(dir, "..", `${basename(dir)}-plugin-ran`);
    dirs.push(marker);
    mkdirSync(join(dir, ".ocra"));
    writeFileSync(
      join(dir, ".ocra", "evil.mjs"),
      `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "x"); export default { name: "evil" };\n`,
    );
    writeFileSync(join(dir, ".ocra", "config.json"), '{"plugins": ["./.ocra/evil.mjs"]}');
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
      dataset: "aacr",
      outDir: join(dir, "out"),
      reposDir: dir,
      command: defaultOcraCommand(),
      prepare: async () => dir,
      log: (m) => logs.push(m),
    });
    expect(logs).toEqual(["[1/1] local@1: 2 issue(s) classified"]);
    expect(markdown).toContain("# Recall ceiling, AACR-Bench");
    expect(markdown).toContain("| Reachable | 1 | 50.0% |");
    expect(markdown).toContain("Risk tiers: trivial 1, lite 0, full 0.");
    expect(markdown).toContain("Excluded files by reason: generated 1");
    expect(existsSync(marker)).toBe(false);

    // A golden case written against the wrong commits is refused, not scored.
    const golden: Instance = {
      ...instance,
      id: "golden-case",
      references: [],
      golden: {
        tier: "smoke",
        clean: false,
        forbid: [{ path: "other.ts", fromLine: 1, toLine: 1, reason: "r" }],
        adjudicated: [],
        minSeverity: [],
        alternates: [],
      },
    };
    logs.length = 0;
    const refused = await measureCeiling([golden], {
      dataset: "golden",
      outDir: join(dir, "out"),
      reposDir: dir,
      command: defaultOcraCommand(),
      prepare: async () => dir,
      log: (m) => logs.push(m),
    });
    expect(logs).toEqual([
      "[1/1] golden-case: failed: the case names files the change does not touch: other.ts",
    ]);
    expect(refused).toContain(
      "# Recall ceiling, golden cases\n\n0 expected findings in 0 case(s),",
    );
  });
});
