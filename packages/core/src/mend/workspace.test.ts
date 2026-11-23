import { describe, expect, it } from "vitest";
import type { ReviewContext } from "../contracts.js";
import { applyHunks } from "./patch.js";
import { Workspace } from "./workspace.js";

const FILE = ["function a() {", "  one();", "  two();", "}", "", "function b() {", "  one();", "}"];
const HEAD = FILE.join("\n");

function workspace(files: Record<string, string> = { "src/a.ts": HEAD }) {
  const head: ReviewContext = {
    readFile: async (path) => {
      if (path === ".env") throw new Error("refused by the access policy");
      return files[path];
    },
    readDiff: (path) => (path in files ? `diff of ${path}` : undefined),
    searchCode: async () => [{ path: "src/a.ts", line: 2, text: "  one();" }],
  };
  return new Workspace(head);
}

// The patch is right when the head with its hunks applied is what the lane reads.
async function settled(ws: Workspace, path = "src/a.ts", head = HEAD) {
  const { hunks, heads } = ws.patch();
  expect(heads.get(path)).toBe(head);
  expect(applyHunks(head, hunks)).toBe(await ws.context.readFile(path));
  return hunks;
}

describe("Workspace.replace", () => {
  it("replaces whole lines found exactly once, and reads show the edit", async () => {
    const ws = workspace();
    expect(await ws.replace("src/a.ts", "  two();", "  two();\n  three();")).toEqual({
      startLine: 3,
      lines: 2,
    });
    expect((await ws.context.readFile("src/a.ts"))?.split("\n").slice(1, 4)).toEqual([
      "  one();",
      "  two();",
      "  three();",
    ]);
    expect(ws.context.readDiff("src/a.ts")).toBe("diff of src/a.ts");
    expect(await settled(ws)).toEqual([
      { path: "src/a.ts", startLine: 3, endLine: 3, replacement: "  two();\n  three();" },
    ]);
  });

  it("refuses lines that are missing, repeated or unchanged, and a file it cannot read", async () => {
    const ws = workspace();
    expect(await ws.replace("src/a.ts", "  three();", "x")).toBe("not_found");
    expect(await ws.replace("src/a.ts", "\n\n", "x")).toBe("not_found");
    expect(await ws.replace("src/a.ts", "  one();", "x")).toBe("ambiguous");
    expect(await ws.replace("src/a.ts", "  two();", "  two();\n")).toBe("unchanged");
    expect(await ws.replace("src/new.ts", "a", "b")).toBe("missing");
    expect(await ws.replace(".env", "a", "b")).toBe("missing");
    expect(ws.patch()).toEqual({ hunks: [], heads: new Map() });
  });

  it("finds lines by their text when only the indentation differs", async () => {
    const ws = workspace();
    expect(await ws.replace("src/a.ts", "two();\n}\n", "  2;\n}")).toEqual({
      startLine: 3,
      lines: 2,
    });
    expect(await settled(ws)).toEqual([
      { path: "src/a.ts", startLine: 3, endLine: 3, replacement: "  2;" },
    ]);
  });
});

describe("Workspace.patch", () => {
  it("gives one hunk per edited run, in head line numbers, whatever the order of edits", async () => {
    const ws = workspace();
    await ws.replace("src/a.ts", "function b() {\n  one();", "function b() {\n  uno();\n  dos();");
    await ws.replace("src/a.ts", "function a() {", "function a(x) {");
    await ws.replace("src/a.ts", "  dos();", "  two();");
    expect(await settled(ws)).toEqual([
      { path: "src/a.ts", startLine: 1, endLine: 1, replacement: "function a(x) {" },
      { path: "src/a.ts", startLine: 7, endLine: 7, replacement: "  uno();\n  two();" },
    ]);
  });

  it("deletes lines, and drops an edit a later one takes back", async () => {
    const ws = workspace();
    await ws.replace("src/a.ts", "  two();", "");
    expect(await settled(ws)).toEqual([
      { path: "src/a.ts", startLine: 3, endLine: 3, replacement: "" },
    ]);
    const back = workspace();
    await back.replace("src/a.ts", "  two();", "  2;");
    await back.replace("src/a.ts", "  2;", "  two();");
    expect(back.patch().hunks).toEqual([]);
  });

  it("takes a neighbouring line where a hunk could not say the edit", async () => {
    const blank = workspace();
    // A line that becomes an empty one: an empty replacement would delete it.
    await blank.replace("src/a.ts", "  one();\n  two();\n}", "  one();\n\n}");
    expect(await settled(blank)).toEqual([
      { path: "src/a.ts", startLine: 2, endLine: 3, replacement: "  one();\n" },
    ]);
    const top = workspace({ "src/a.ts": "one\ntwo" });
    await top.replace("src/a.ts", "one", "zero\none");
    await top.replace("src/a.ts", "two", "two\nthree");
    expect(await settled(top, "src/a.ts", "one\ntwo")).toEqual([
      { path: "src/a.ts", startLine: 1, endLine: 1, replacement: "zero\none" },
      { path: "src/a.ts", startLine: 2, endLine: 2, replacement: "two\nthree" },
    ]);
    const between = workspace({ "src/a.ts": "one\ntwo" });
    await between.replace("src/a.ts", "one", "zero\none\nhalf");
    expect(await settled(between, "src/a.ts", "one\ntwo")).toEqual([
      { path: "src/a.ts", startLine: 1, endLine: 1, replacement: "zero\none\nhalf" },
    ]);
  });

  it("keeps the files apart, sorted by path", async () => {
    const ws = workspace({ "src/b.ts": "b", "src/a.ts": "a" });
    await ws.replace("src/b.ts", "b", "B");
    await ws.replace("src/a.ts", "a", "A");
    expect(ws.patch().hunks.map((h) => h.path)).toEqual(["src/a.ts", "src/b.ts"]);
  });
});
