import { describe, expect, it } from "vitest";
import { forTerminal } from "./terminal.js";

describe("forTerminal", () => {
  it("keeps text, tabs and newlines", () => {
    expect(forTerminal("a\tb\nc — ü 中文")).toBe("a\tb\nc — ü 中文");
  });

  it("replaces escape sequences, carriage returns and bidi overrides", () => {
    const clipboard = "\u001b]52;c;ZXZpbA==\u0007";
    const recolor = "\u001b[2K\u001b[1A";
    const c1 = "\u009b31m";
    const bidi = "admin‮⁦";
    const out = forTerminal(`${clipboard}${recolor}\r${c1}${bidi}`);
    for (const unsafe of ["\u001b", "\u0007", "\r", "\u009b", "\u202e", "\u2066"]) {
      expect(out).not.toContain(unsafe);
    }
    expect(out).toContain("]52;c;ZXZpbA==");
  });
});
