import { describe, expect, it } from "vitest";
import { checkFix, MAX_ADDED_LINES, MAX_FIX_CHARS } from "./check.js";
import { anchored, braceSyntax, SOURCE } from "./fix.fakes.js";

const loop = anchored(7, 7);
const fixedLoop = "  for (let i = 0; i < prices.length; i++) sum += prices[i];";

describe("checkFix", () => {
  it("keeps a replacement of exactly the anchored lines", async () => {
    expect(await checkFix(loop, SOURCE, fixedLoop, braceSyntax)).toEqual({
      fix: { startLine: 7, endLine: 7, replacement: fixedLoop },
    });
  });

  it("drops one trailing newline, which is not part of the lines", async () => {
    expect(await checkFix(loop, SOURCE, `${fixedLoop}\n`, braceSyntax)).toEqual({
      fix: { startLine: 7, endLine: 7, replacement: fixedLoop },
    });
  });

  it("keeps a deletion", async () => {
    expect(await checkFix(anchored(6, 6), SOURCE, "", braceSyntax)).toEqual({
      fix: { startLine: 6, endLine: 6, replacement: "" },
    });
  });

  it("refuses a fix for lines that are no longer what the finding quoted", async () => {
    const moved = `// a new first line\n${SOURCE}`;
    expect(await checkFix(loop, moved, fixedLoop, braceSyntax)).toEqual({ rejected: "stale" });
    expect(await checkFix(loop, "short", fixedLoop, braceSyntax)).toEqual({ rejected: "stale" });
    const { quote: _, ...unquoted } = loop;
    expect(await checkFix(unquoted, SOURCE, fixedLoop, braceSyntax)).toEqual({ rejected: "stale" });
  });

  it("refuses a replacement that changes nothing", async () => {
    const same = SOURCE.split("\n")[6] as string;
    expect(await checkFix(loop, SOURCE, same, braceSyntax)).toEqual({ rejected: "unchanged" });
  });

  it("refuses carriage returns and invisible controls rather than strip them", async () => {
    for (const bad of [`${fixedLoop}\r`, `  sum += 1;‮`, "  a\u0000b"]) {
      expect(await checkFix(loop, SOURCE, bad, braceSyntax)).toEqual({ rejected: "unsafe" });
    }
  });

  it("refuses a rewrite larger than a local edit", async () => {
    const many = Array.from({ length: MAX_ADDED_LINES + 2 }, () => "  sum += 0;").join("\n");
    expect(await checkFix(loop, SOURCE, many, braceSyntax)).toEqual({ rejected: "too_large" });
    const long = `  // ${"x".repeat(MAX_FIX_CHARS)}`;
    expect(await checkFix(loop, SOURCE, long, braceSyntax)).toEqual({ rejected: "too_large" });
  });

  it("refuses a fix that leaves the file with more syntax errors", async () => {
    const broken = "  for (let i = 0; i < prices.length; i++) { sum += prices[i];";
    expect(await checkFix(loop, SOURCE, broken, braceSyntax)).toEqual({ rejected: "syntax" });
  });

  it("accepts a fix in a file that already had errors, if it adds none", async () => {
    const already = `${SOURCE}\n}`;
    const finding = anchored(7, 7, {}, already);
    expect(await checkFix(finding, already, fixedLoop, braceSyntax)).toHaveProperty("fix");
  });

  it("refuses a fix it cannot parse", async () => {
    const finding = { ...loop, file: "src/a.rb" };
    expect(await checkFix(finding, SOURCE, fixedLoop, braceSyntax)).toEqual({
      rejected: "no_parser",
    });
  });
});
