import { describe, expect, it } from "vitest";
import { opencodeFlags } from "./action-install.mjs";

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
