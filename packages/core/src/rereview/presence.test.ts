import { describe, expect, it } from "vitest";
import { quoteSignature } from "../anchor/quote.js";
import type { PriorReview } from "../domain.js";
import { priorCodePresence } from "./presence.js";

const file = ["function f(a) {", "  if (!a) return;", "", "  return a.b;", "}"].join("\n");

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
