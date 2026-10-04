import { describe, expect, it } from "vitest";
import { changeRequestSchema, codeSourceSchema, historySchema } from "./options.js";

const SHA = "a".repeat(40);

describe("the platform adapters' shared options", () => {
  it("takes a change request as ocra reads it, and refuses a platform's raw answer", () => {
    const cr = { id: "o/r#7", title: "t", description: "", baseSha: SHA, headSha: SHA };
    expect(changeRequestSchema.parse(cr)).toEqual(cr);
    const raw = { number: 7, title: "t", body: null, base: { sha: SHA }, head: { sha: SHA } };
    expect(changeRequestSchema.safeParse(raw).success).toBe(false);
  });

  it("refuses anything but a commit id as a commit", () => {
    const cr = { id: "x", title: "t", description: "", baseSha: "--upload-pack=x", headSha: SHA };
    expect(changeRequestSchema.safeParse(cr).success).toBe(false);
  });

  it("checks that the code source and the history have their methods", () => {
    const code = {
      getDiff: async () => [],
      readFile: async () => undefined,
      searchCode: async () => [],
    };
    expect(codeSourceSchema.safeParse(code).success).toBe(true);
    expect(codeSourceSchema.safeParse({ getDiff: () => [] }).error?.issues[0]?.message).toBe(
      "code must provide getDiff, readFile and searchCode",
    );
    expect(
      historySchema.safeParse({ filesChangedSince: async () => ({ files: [] }) }).success,
    ).toBe(true);
    expect(historySchema.safeParse({}).success).toBe(false);
  });
});
