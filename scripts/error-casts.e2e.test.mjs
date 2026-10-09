import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

// The Biome plugin biome-plugins/error-casts.grit is what keeps error
// handling on core's helpers (#391); this shows it fires.
const root = fileURLToPath(new URL("..", import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "ocra-error-casts-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/**
 * @param {string} name
 * @param {string} source
 */
function lint(name, source) {
  const file = join(dir, name);
  writeFileSync(file, source);
  const biome = join(root, "node_modules", ".bin", "biome");
  return spawnSync(biome, ["lint", `--config-path=${root}`, file], { encoding: "utf8" });
}

describe("the error-casts Biome plugin", () => {
  it.each([
    [
      "a cast to Error",
      "export const f = (e: unknown) => (e as Error).message;\n",
      "errorMessage()",
    ],
    [
      "a cast to NodeJS.ErrnoException",
      'export const f = (e: unknown) => (e as NodeJS.ErrnoException).code === "ENOENT";\n',
      "isNotFound()",
    ],
    [
      "a copy of errorMessage",
      "export const f = (e: unknown) => (e instanceof Error ? e.message : String(e));\n",
      "errorMessage()",
    ],
  ])("fails %s", (_, source, helper) => {
    const result = lint("bad.ts", source);
    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toContain(helper);
  });

  it("passes the helpers", () => {
    const result = lint(
      "good.ts",
      'import { errorMessage } from "@open-cr-agent/core";\nexport const f = (e: unknown) => errorMessage(e);\n',
    );
    expect(result.stdout + result.stderr).not.toContain("plugin");
    expect(result.status).toBe(0);
  });
});
