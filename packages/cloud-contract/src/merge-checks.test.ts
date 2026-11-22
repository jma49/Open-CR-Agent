import { describe, expect, it } from "vitest";
import { MAX_MERGE_CHECK_INSTRUCTION, mergeCheckSchema } from "./merge-checks.js";

describe("a configured merge check", () => {
  it("takes an id and an instruction, trimmed", () => {
    expect(mergeCheckSchema.parse({ id: "chk_1", instruction: "  Say why.  " })).toEqual({
      id: "chk_1",
      instruction: "Say why.",
    });
  });

  it("refuses an empty or long instruction, an id that is not one, and unknown keys", () => {
    for (const check of [
      { id: "chk_1", instruction: "   " },
      { id: "chk_1", instruction: "x".repeat(MAX_MERGE_CHECK_INSTRUCTION + 1) },
      { id: "a b", instruction: "Say why." },
      { id: "chk_1", instruction: "Say why.", mode: "block" },
    ]) {
      expect(mergeCheckSchema.safeParse(check).success, JSON.stringify(check)).toBe(false);
    }
  });
});
