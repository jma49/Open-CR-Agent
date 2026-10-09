import { describe, expect, it } from "vitest";
import { npmCommand, opencodeFlags } from "./action-install.mjs";

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
