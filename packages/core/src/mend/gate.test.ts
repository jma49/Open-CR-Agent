import { describe, expect, it } from "vitest";
import { parseUnifiedDiff } from "../diff/parse.js";
import { braceSyntax } from "../fix/fix.fakes.js";
import { gate, mendScope } from "./gate.js";
import type { ItemPatch } from "./patch.js";

const limits = { files: 10, addedLines: 200 };

function added(path: string, mode = "100644"): string {
  return [
    `diff --git a/${path} b/${path}`,
    `new file mode ${mode}`,
    "index 0000000..2222222",
    "--- /dev/null",
    `+++ b/${path}`,
    "@@ -0,0 +1,3 @@",
    "+function f() {",
    "+  return 1;",
    "+}",
  ].join("\n");
}

const CODE = ["function f() {", "  return 1;", "}"].join("\n");
const TEST = ["it('adds', () => {", "  expect(f()).toBe(1);", "});"].join("\n");

function edit(path: string, replacement: string, startLine = 2, endLine = 2): ItemPatch {
  return { item: "p1", hunks: [{ path, startLine, endLine, replacement }] };
}

function check(patch: ItemPatch, paths: string[], content = CODE, extra: string[] = []) {
  const diffs = parseUnifiedDiff(paths.map((p) => added(p)).join("\n"));
  const heads = new Map(patch.hunks.map((h) => [h.path, content]));
  return gate(patch, heads, mendScope(diffs, extra), braceSyntax, limits);
}

describe("mendScope", () => {
  it("lets a round edit only regular files of the change that a review reads", () => {
    const diffs = parseUnifiedDiff(
      [added("src/a.ts"), added("src/link.ts", "120000"), added("dist/out.min.js")].join("\n"),
    );
    const scope = mendScope(diffs);
    expect(scope.refusal("src/a.ts")).toBeUndefined();
    expect(scope.refusal("src/other.ts")).toBe("out_of_scope");
    expect(scope.refusal("src/link.ts")).toBe("out_of_scope");
    expect(scope.refusal("dist/out.min.js")).toBe("protected");
  });

  it("protects how the change is built, tested and owned, even inside the change", () => {
    const paths = [
      ".github/workflows/ci.yml",
      ".gitlab-ci.yml",
      ".ocra/config.json",
      "AGENTS.md",
      "packages/a/package.json",
      "package-lock.json",
      "db/migrations/0001_init.sql",
      "CODEOWNERS",
    ];
    const scope = mendScope(parseUnifiedDiff(paths.map((p) => added(p)).join("\n")));
    for (const path of paths) expect(scope.refusal(path), path).toBe("protected");
  });

  it("adds a repository's own protected paths and removes none", () => {
    const diffs = parseUnifiedDiff([added("src/billing/a.ts"), added("package.json")].join("\n"));
    const scope = mendScope(diffs, ["src/billing/**", "!package.json"]);
    expect(scope.refusal("src/billing/a.ts")).toBe("protected");
    expect(scope.refusal("package.json")).toBe("protected");
  });
});

describe("gate", () => {
  it("passes a small edit of a file of the change", async () => {
    expect(await check(edit("src/a.ts", "  return 2;"), ["src/a.ts"])).toBeUndefined();
  });

  it("refuses a file outside the change and a protected one", async () => {
    expect(await check(edit("src/b.ts", "  return 2;"), ["src/a.ts"])).toBe("out_of_scope");
    expect(await check(edit("package.json", "{}"), ["package.json"])).toBe("protected");
  });

  it("refuses an edit past the file's end", async () => {
    expect(await check(edit("src/a.ts", "x", 9, 9), ["src/a.ts"])).toBe("stale");
  });

  it("refuses invisible and bidirectional characters", async () => {
    expect(await check(edit("src/a.ts", "  return 2; ‮"), ["src/a.ts"])).toBe("unsafe");
    expect(await check(edit("src/a.ts", "  return 2;\r"), ["src/a.ts"])).toBe("unsafe");
  });

  it("refuses an edit that leaves the file with more syntax errors", async () => {
    expect(await check(edit("src/a.ts", "  return 2; }"), ["src/a.ts"])).toBe("syntax");
    expect(await check(edit("src/a.py", "  return 2"), ["src/a.py"])).toBe("no_parser");
  });

  it("refuses more files or lines than a round may write", async () => {
    const tall = edit("src/a.ts", Array.from({ length: 201 }, () => "  f();").join("\n"));
    expect(await check(tall, ["src/a.ts"])).toBe("too_large");
  });

  it("refuses an edit that turns a test off, and passes one that does not", async () => {
    const path = "src/a.test.ts";
    expect(await check(edit(path, "it.skip('adds', () => {", 1, 1), [path], TEST)).toBe("tamper");
    expect(await check(edit(path, "xit('adds', () => {", 1, 1), [path], TEST)).toBe("tamper");
    expect(await check(edit(path, "  expect(f()).toBe(2);"), [path], TEST)).toBeUndefined();
    const skipped = TEST.replace("it(", "it.skip(");
    expect(
      await check(edit(path, "it.skip('sums', () => {", 1, 1), [path], skipped),
    ).toBeUndefined();
  });
});
