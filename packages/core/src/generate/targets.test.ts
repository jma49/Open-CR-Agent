import { describe, expect, it } from "vitest";
import { parseUnifiedDiff } from "../diff/parse.js";
import { generationTargets, MAX_TARGETS } from "./targets.js";

function diff(path: string, added: number, header: string[] = ["index 1111111..2222222 100644"]) {
  return [
    `diff --git a/${path} b/${path}`,
    ...header,
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -1 +1,${added + 1} @@`,
    " keep",
    ...Array.from({ length: added }, (_, i) => `+line ${i}`),
  ].join("\n");
}

const paths = (text: string[], kind: "tests" | "docstrings" = "tests") =>
  generationTargets(kind, parseUnifiedDiff(text.join("\n"))).targets.map((t) => t.diff.newPath);

describe("generationTargets", () => {
  it("takes changed code, never a test, a declaration file or prose", () => {
    expect(
      paths([
        diff("src/retry.ts", 2),
        diff("src/retry.test.ts", 9),
        diff("src/__tests__/upload.ts", 9),
        diff("types/api.d.ts", 9),
        diff("README.md", 9),
        diff("tests/helpers.py", 9),
      ]),
    ).toEqual(["src/retry.ts"]);
  });

  it("writes tests only where the language has a convention, doc comments in more", () => {
    const changed = [diff("src/lib.rs", 3), diff("src/main.go", 2)];
    expect(paths(changed, "tests")).toEqual(["src/main.go"]);
    expect(paths(changed, "docstrings")).toEqual(["src/lib.rs", "src/main.go"]);
  });

  it("leaves out symbolic links and submodules, and keeps an executable's mode", () => {
    const diffs = parseUnifiedDiff(
      [
        diff("bin/run.py", 2, ["index 1111111..2222222 100755"]),
        diff("link.ts", 2, ["new file mode 120000", "index 0000000..2222222"]),
        diff("dep.go", 2, ["index 1111111..2222222 160000"]),
      ].join("\n"),
    );
    const { targets } = generationTargets("docstrings", diffs);
    expect(targets.map((t) => [t.diff.newPath, t.executable])).toEqual([["bin/run.py", true]]);
  });

  it("takes the files with the most added lines first, up to the limit", () => {
    const many = Array.from({ length: MAX_TARGETS + 2 }, (_, i) => diff(`src/f${i}.ts`, i + 1));
    const { targets, skipped } = generationTargets("tests", parseUnifiedDiff(many.join("\n")));
    expect(targets).toHaveLength(MAX_TARGETS);
    expect(targets[0]?.diff.newPath).toBe(`src/f${MAX_TARGETS + 1}.ts`);
    expect(skipped.map((s) => s.path)).toEqual(["src/f1.ts", "src/f0.ts"]);
  });
});
