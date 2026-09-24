import { describe, expect, it } from "vitest";
import { readQuotedToken } from "./quoted-path.js";

describe("readQuotedToken", () => {
  it("decodes octal escapes as UTF-8 bytes", () => {
    expect(readQuotedToken('"a/\\346\\226\\207.txt" rest', 0)).toEqual({
      value: "a/文.txt",
      end: 20,
    });
  });

  it("decodes simple escapes", () => {
    expect(readQuotedToken('"a\\tb\\"c\\\\d"', 0)?.value).toBe('a\tb"c\\d');
  });

  it("rejects unquoted, unterminated and badly escaped input", () => {
    expect(readQuotedToken("plain", 0)).toBeUndefined();
    expect(readQuotedToken('"open', 0)).toBeUndefined();
    expect(readQuotedToken('"bad\\q"', 0)).toBeUndefined();
  });
});
