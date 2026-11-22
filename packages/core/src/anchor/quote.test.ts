import { describe, expect, it } from "vitest";
import { containsQuote, quoteSignature } from "./quote.js";

const file = ["function f(a) {", "  if (!a) return;", "", "  return a.b;", "}"].join("\n");

describe("quoteSignature", () => {
  it("signs the anchored lines, whitespace and blank lines ignored", () => {
    const signature = quoteSignature(file, { start: 2, end: 4 });
    if (signature === undefined) throw new Error("no signature");
    expect(signature.lines).toBe(2);
    const reformatted = ["// moved", "function f(a) {", "if (!a)   return;", "return a.b;", "}"];
    expect(containsQuote(reformatted.join("\r\n"), signature)).toBe(true);
  });

  it("no longer matches once the code changes", () => {
    const signature = quoteSignature(file, { start: 4, end: 4 });
    if (signature === undefined) throw new Error("no signature");
    expect(containsQuote(file, signature)).toBe(true);
    expect(containsQuote(file.replace("a.b", "a?.b"), signature)).toBe(false);
  });

  it("has no signature for blank lines", () => {
    expect(quoteSignature(file, { start: 3, end: 3 })).toBeUndefined();
  });
});
