import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadAllowedPlugins, loadExternalPlugins } from "./load.js";
import { writeAllowed } from "./store.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "ocra-plugin-load-"));
  dirs.push(dir);
  return dir;
}

// A package whose `exports` name an entry for one condition only.
function plugin(dir: string, name: string, exports: Record<string, string>): void {
  const root = join(dir, "node_modules", name);
  mkdirSync(root, { recursive: true });
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ name, version: "1.0.0", type: "module", exports: { ".": exports } }),
  );
  const source = (file: string) =>
    file.endsWith(".cjs")
      ? `module.exports = { name: "${name}", configure() {} };\n`
      : `export default { name: "${name}", configure() {} };\n`;
  for (const file of Object.values(exports)) writeFileSync(join(root, file), source(file));
}

describe("loadExternalPlugins", () => {
  it("loads a plugin whose package exports an entry for import only, or for require only", async () => {
    const root = scratch();
    writeFileSync(join(root, "package.json"), "{}");
    plugin(root, "ocra-plugin-esm", { import: "./index.js" });
    plugin(root, "ocra-plugin-cjs", { require: "./index.cjs" });
    await expect(
      loadExternalPlugins(["ocra-plugin-esm", "ocra-plugin-cjs"], root),
    ).resolves.toMatchObject([{ name: "ocra-plugin-esm" }, { name: "ocra-plugin-cjs" }]);
  });
});

describe("loadAllowedPlugins", () => {
  it("loads an allowed plugin whose package exports an entry for import only", async () => {
    const dir = scratch();
    plugin(dir, "ocra-plugin-esm", { import: "./index.js" });
    const record = { name: "ocra-plugin-esm", version: "1.0.0", integrity: "sha512-x" };
    writeFileSync(
      join(dir, "package-lock.json"),
      JSON.stringify({ packages: { "node_modules/ocra-plugin-esm": record } }),
    );
    await writeAllowed(dir, [record]);
    const warnings: string[] = [];
    const loaded = await loadAllowedPlugins(["ocra-plugin-esm"], dir, (w) => warnings.push(w));
    expect(warnings).toEqual([]);
    expect(loaded.map((p) => p.name)).toEqual(["ocra-plugin-esm"]);
  });
});
