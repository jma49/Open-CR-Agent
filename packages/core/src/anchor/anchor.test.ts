import { describe, expect, it, vi } from "vitest";
import { parseUnifiedDiff } from "../diff/parse.js";
import { type AnchorContext, anchorFinding } from "./anchor.js";

const diffs = parseUnifiedDiff(
  [
    "diff --git a/a.ts b/a.ts",
    "--- a/a.ts",
    "+++ b/a.ts",
    "@@ -1,1 +1,2 @@",
    " const a = 1;",
    "+const b = 2;",
    "diff --git a/b.ts b/b.ts",
    "--- a/b.ts",
    "+++ b/b.ts",
    "@@ -5,1 +5,2 @@",
    " export {};",
    "+runTask(spec);",
  ].join("\n"),
);

const files: Record<string, string> = {
  "a.ts": "const a = 1;\nconst b = 2;\n\nfunction far() {\n  return a;\n}\n",
};

function context(overrides: Partial<AnchorContext> = {}): AnchorContext {
  return { diffs, readNewFile: async (path) => files[path], ...overrides };
}

function finding(file: string, existingCode: string) {
  return { file, existingCode, body: "issue" };
}

describe("anchorFinding", () => {
  it("anchors in the finding's own hunks first", async () => {
    expect(await anchorFinding(finding("a.ts", "const b = 2;"), context())).toEqual({
      file: "a.ts",
      method: "hunk",
      lineRange: { start: 2, end: 2 },
      inDiff: true,
    });
  });

  it("falls back to full file content outside the diff", async () => {
    expect(await anchorFinding(finding("a.ts", "return a;"), context())).toEqual({
      file: "a.ts",
      method: "file",
      lineRange: { start: 5, end: 5 },
      inDiff: false,
    });
  });

  it("moves a finding filed on the wrong file", async () => {
    expect(await anchorFinding(finding("a.ts", "runTask(spec);"), context())).toMatchObject({
      file: "b.ts",
      method: "cross_file",
      lineRange: { start: 6, end: 6 },
    });
  });

  it("asks the relocator only after deterministic matching fails", async () => {
    const relocate = vi.fn(async () => "const b = 2;");
    const anchor = await anchorFinding(finding("a.ts", "const b = 3;"), context({ relocate }));
    expect(relocate).toHaveBeenCalledOnce();
    expect(anchor).toMatchObject({ method: "relocated", lineRange: { start: 2, end: 2 } });

    relocate.mockClear();
    await anchorFinding(finding("a.ts", "const b = 2;"), context({ relocate }));
    expect(relocate).not.toHaveBeenCalled();
  });

  it("keeps the finding as file-level when nothing matches", async () => {
    const relocate = async () => "still not there";
    expect(await anchorFinding(finding("a.ts", "nope"), context({ relocate }))).toEqual({
      file: "a.ts",
      method: "file_level",
      inDiff: false,
    });
  });

  it("records relocation failures instead of throwing", async () => {
    const relocate = async () => {
      throw new Error("model overloaded");
    };
    expect(await anchorFinding(finding("a.ts", "nope"), context({ relocate }))).toMatchObject({
      method: "file_level",
      warning: "relocation failed: model overloaded",
    });
  });

  it("keeps findings on files outside the change set", async () => {
    expect(await anchorFinding(finding("zzz.ts", "nope"), context())).toMatchObject({
      file: "zzz.ts",
      method: "file_level",
    });
  });
});
