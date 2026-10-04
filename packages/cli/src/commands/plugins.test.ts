import { mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defaultNpm } from "../plugins/npm.js";
import { fakeNpm } from "../plugins/plugins.fakes.js";
import { pluginsDir, readAllowed } from "../plugins/store.js";
import { capture, critical, deps } from "../run.fakes.js";
import { run } from "../run.js";

const homes: string[] = [];
afterEach(() => {
  for (const dir of homes.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const PACKAGES = {
  "ocra-plugin-x@1.2.3": {
    publisher: "alice <alice@example.com>",
    maintainers: ["alice <alice@example.com>", "bob <bob@example.com>"],
    integrity: "sha512-good",
  },
  "@scope/tampered@1.0.0": { integrity: "sha512-registry", installedIntegrity: "sha512-other" },
  "ocra-plugin-esc@1.0.0": { publisher: "\u001b]8;;evil\u0007mallory", integrity: "sha512-e" },
  "ocra-plugin-unlisted@1.0.0": { integrity: "sha512-u", unlisted: true },
};

function setup() {
  const home = mkdtempSync(join(tmpdir(), "ocra-plugins-"));
  homes.push(home);
  const env = { XDG_CONFIG_HOME: home };
  const fake = fakeNpm(PACKAGES);
  const plugins = async (...argv: string[]) => {
    const out = capture();
    const err = capture();
    const code = await run(
      ["plugins", ...argv],
      out,
      err,
      deps(home, critical, { env, npm: fake.npm }),
    );
    return { code, out: out.text(), err: err.text() };
  };
  return { dir: pluginsDir(env), calls: fake.calls, cwds: fake.cwds, plugins };
}

describe("ocra plugins allow", () => {
  it("refuses without an exact version or with a name npm could misread, before running npm", async () => {
    const { plugins, calls } = setup();
    for (const spec of [
      "ocra-plugin-x",
      "ocra-plugin-x@^1.2.3",
      "ocra-plugin-x@latest",
      "ocra-plugin-x@1.2",
      "-g@1.0.0",
      "../evil@1.0.0",
      "/abs/path@1.0.0",
      "Upper@1.0.0",
      "git+https://evil.example/x.git@1.0.0",
    ]) {
      const { code, err } = await plugins("allow", spec);
      expect(code, spec).toBe(2);
      expect(err).toContain("Usage: ocra plugins");
    }
    expect(calls).toEqual([]);
  });

  it("shows the package and its publisher, installs it with scripts off and records its integrity", async () => {
    const { plugins, calls, cwds, dir } = setup();
    const { code, out } = await plugins("allow", "ocra-plugin-x@1.2.3");
    expect(code).toBe(0);
    expect(out).toContain("Package:      ocra-plugin-x@1.2.3");
    expect(out).toContain("Published by: alice <alice@example.com>");
    expect(out).toContain("Maintainers:  alice <alice@example.com>, bob <bob@example.com>");
    expect(calls).toEqual([
      ["view", "ocra-plugin-x@1.2.3", "--json"],
      [
        "install",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--save-exact",
        "--prefix",
        dir,
        "ocra-plugin-x@1.2.3",
      ],
    ]);
    expect(cwds).toEqual([dir, dir]);
    expect(await readAllowed(dir)).toEqual([
      { name: "ocra-plugin-x", version: "1.2.3", integrity: "sha512-good" },
    ]);
    expect(JSON.parse(readFileSync(join(dir, "package.json"), "utf8"))).toEqual({ private: true });
    if (process.platform !== "win32") {
      expect(statSync(join(dir, "plugins.json")).mode & 0o777).toBe(0o600);
      expect(statSync(dir).mode & 0o777).toBe(0o700);
    }
    expect((await plugins("list")).out).toContain("ocra-plugin-x@1.2.3  sha512-good");
  });

  it("records nothing when the installed package is not what the registry lists", async () => {
    const { plugins, dir } = setup();
    const { code, err } = await plugins("allow", "@scope/tampered@1.0.0");
    expect(code).toBe(2);
    expect(err).toContain("another integrity");
    expect(await readAllowed(dir)).toEqual([]);
  });

  it("refuses a package whose registry entry lists no integrity, before installing it", async () => {
    const { plugins, calls, dir } = setup();
    const { code, err } = await plugins("allow", "ocra-plugin-unlisted@1.0.0");
    expect(code).toBe(2);
    expect(err).toContain("lists no integrity");
    expect(calls.map((c) => c[0])).toEqual(["view"]);
    expect(await readAllowed(dir)).toEqual([]);
  });

  it("strips control characters from what npm says", async () => {
    const { plugins } = setup();
    const { out } = await plugins("allow", "ocra-plugin-esc@1.0.0");
    expect(out).toContain("mallory");
    expect(out).not.toContain("\u001b");
  });
});

describe("ocra plugins deny and list", () => {
  it("removes an allowed plugin and its files", async () => {
    const { plugins, dir, calls } = setup();
    expect((await plugins("list")).out).toContain("No plugins allowed");
    await plugins("allow", "ocra-plugin-x@1.2.3");
    const { code, out } = await plugins("deny", "ocra-plugin-x");
    expect(code).toBe(0);
    expect(out).toContain("Denied ocra-plugin-x");
    expect(await readAllowed(dir)).toEqual([]);
    expect(calls.at(-1)?.[0]).toBe("uninstall");
    expect((await plugins("deny", "ocra-plugin-x")).out).toContain("was not allowed");
  });
});

describe("the npm ocra runs", () => {
  it("runs in the directory it is given, so that directory's npm project applies", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ocra-npm-cwd-"));
    homes.push(dir);
    writeFileSync(join(dir, "package.json"), "{}");
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !key.toLowerCase().startsWith("npm_")),
    );
    const prefix = await defaultNpm(env)(["prefix"], dir);
    expect(realpathSync(prefix.trim())).toBe(realpathSync(dir));
  }, 30_000);
});
