import { describe, expect, it } from "vitest";
import { languageOf } from "./languages.js";

function testPath(source: string, listed: Record<string, string[]> = {}): string | undefined {
  return languageOf(source)?.tests?.pathFor(source, (dir) => listed[dir] ?? []);
}

describe("the test path of a source file", () => {
  it("follows the repository's TypeScript and JavaScript naming beside the source", () => {
    expect(testPath("src/retry.ts")).toBe("src/retry.test.ts");
    expect(testPath("app.mjs")).toBe("app.test.mjs");
    expect(testPath("src/retry.ts", { src: ["src/upload.spec.ts"] })).toBe("src/retry.spec.ts");
    expect(testPath("src/retry.ts", { src: ["src/a.spec.ts", "src/b.test.ts"] })).toBe(
      "src/retry.test.ts",
    );
    expect(testPath("src/retry.tsx", { "src/__tests__": ["src/__tests__/x.test.tsx"] })).toBe(
      "src/__tests__/retry.test.tsx",
    );
    expect(testPath("x.ts", { __tests__: ["__tests__/y.test.ts"] })).toBe("__tests__/x.test.ts");
  });

  it("follows Python's naming beside the source, or in a tests directory", () => {
    expect(testPath("pkg/retry.py")).toBe("pkg/test_retry.py");
    expect(testPath("pkg/retry.py", { pkg: ["pkg/upload_test.py"] })).toBe("pkg/retry_test.py");
    expect(testPath("pkg/retry.py", { tests: ["tests/test_upload.py"] })).toBe(
      "tests/test_retry.py",
    );
  });

  it("uses Go's and the Maven layout's single conventions", () => {
    expect(testPath("cmd/retry.go")).toBe("cmd/retry_test.go");
    expect(testPath("api/src/main/java/com/x/Retry.java")).toBe(
      "api/src/test/java/com/x/RetryTest.java",
    );
    expect(testPath("src/main/kotlin/Retry.kt")).toBe("src/test/kotlin/RetryTest.kt");
    expect(testPath("lib/Retry.java")).toBeUndefined();
  });

  it("writes no tests for Rust, type declarations or files that are not code", () => {
    expect(languageOf("src/lib.rs")?.tests).toBeUndefined();
    expect(languageOf("src/lib.rs")?.doc).toEqual({ kind: "line", marker: "///" });
    expect(languageOf("types/index.d.ts")).toBeUndefined();
    expect(languageOf("README.md")).toBeUndefined();
    expect(languageOf("Makefile")).toBeUndefined();
  });
});
