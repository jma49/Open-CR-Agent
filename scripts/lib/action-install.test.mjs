import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { cacheTrustedRoot, npmCommand, npmDir, opencodeFlags } from "./action-install.mjs";

describe("opencodeFlags", () => {
  it("installs OpenCode unless the opencode input is false", () => {
    expect(opencodeFlags(undefined)).toEqual([]);
    expect(opencodeFlags("")).toEqual([]);
    expect(opencodeFlags("true")).toEqual([]);
    expect(opencodeFlags("false")).toEqual(["--omit=optional"]);
  });

  it("refuses any other value rather than guess", () => {
    expect(() => opencodeFlags("no")).toThrow('the opencode input must be true or false, not "no"');
  });
});

describe("npmCommand", () => {
  // Paths the Action passes: a runner directory with a space, `&` or `^`.
  const args = ["ci", "--cache", "C:\\a b\\R&D^1\\ocra-npm-cache"];

  it("starts the npm that ships with Node on Windows, each argument as it is", () => {
    expect(npmCommand(args, "win32", "C:\\Program Files\\nodejs\\node.exe")).toEqual({
      file: "C:\\Program Files\\nodejs\\node.exe",
      args: ["C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js", ...args],
    });
  });

  it("starts npm by name elsewhere", () => {
    expect(npmCommand(args, "linux", "/usr/bin/node")).toEqual({ file: "npm", args });
  });
});

describe("npmDir", () => {
  it("finds the npm beside this Node, with the TUF client npm verifies with", () => {
    const dir = npmDir();
    expect(createRequire(join(dir, "package.json"))("./package.json").name).toBe("npm");
    expect(existsSync(createRequire(join(dir, "package.json")).resolve("@sigstore/tuf"))).toBe(
      true,
    );
  });

  it("is under the Node directory on Windows and its lib elsewhere", () => {
    expect(npmDir("win32", "C:\\Program Files\\nodejs\\node.exe")).toBe(
      "C:\\Program Files\\nodejs\\node_modules\\npm",
    );
    expect(npmDir("linux", "/opt/node/bin/node")).toBe("/opt/node/lib/node_modules/npm");
  });
});

describe("cacheTrustedRoot", () => {
  it("fetches the trusted root once into the TUF cache npm audit signatures reads", async () => {
    const calls = /** @type {string[]} */ ([]);
    const tuf = {
      /** @param {{ cachePath: string }} options */
      async initTUF(options) {
        calls.push(`init ${options.cachePath}`);
        return {
          /** @param {string} name */
          async getTarget(name) {
            calls.push(`get ${name}`);
            return "{}";
          },
        };
      },
    };
    const cache = join("runner", "ocra-npm-cache");
    await cacheTrustedRoot(cache, tuf);
    // npm's own config: --cache <dir> reads TUF metadata from <dir>/_tuf.
    const npmConfig = createRequire(join(npmDir(), "package.json"))(
      "@npmcli/config/lib/definitions/definitions.js",
    );
    const flat = /** @type {{ tufCache?: string }} */ ({});
    npmConfig.cache.flatten("cache", { cache }, flat);
    expect(calls).toEqual([`init ${flat.tufCache}`, "get trusted_root.json"]);
  });
});
