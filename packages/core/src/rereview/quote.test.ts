import { describe, expect, it } from "vitest";
import type { PriorReview } from "../domain.js";
import { priorCodePresence } from "./presence.js";
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

describe("priorCodePresence", () => {
  const signature = quoteSignature(file, { start: 4, end: 4 });
  if (signature === undefined) throw new Error("no signature");
  const review: PriorReview = {
    findings: [
      {
        fingerprint: "kept",
        title: "t",
        file: "a.ts",
        severity: "warning",
        commented: true,
        quote: signature,
      },
      {
        fingerprint: "changed",
        title: "t",
        file: "b.ts",
        severity: "warning",
        commented: true,
        quote: signature,
      },
      { fingerprint: "deleted", title: "t", file: "gone.ts", severity: "warning", commented: true },
      { fingerprint: "legacy", title: "t", file: "a.ts", severity: "warning", commented: true },
      {
        fingerprint: "unreadable",
        title: "t",
        file: ".env",
        severity: "warning",
        commented: true,
        quote: signature,
      },
      {
        fingerprint: "reported",
        title: "t",
        file: "gone.ts",
        severity: "warning",
        commented: true,
      },
    ],
  };
  const files: Record<string, string> = { "a.ts": file, "b.ts": file.replace("a.b", "a?.b") };

  it("reads each file at head; a deleted file means gone, anything unclear is left out", async () => {
    const presence = await priorCodePresence(review, new Set(["reported"]), async (path) => {
      if (path === ".env") throw new Error("Access denied");
      return files[path];
    });
    expect(Object.fromEntries(presence)).toEqual({ kept: true, changed: false, deleted: false });
  });
});
