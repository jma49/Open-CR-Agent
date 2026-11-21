import { describe, expect, it } from "vitest";
import { isFixSubject, isMinedPath } from "./fixes.js";

describe("isFixSubject", () => {
  it("takes fixes and reverts, not other work that mentions them", () => {
    expect(isFixSubject("fix(cli): wait for the lock")).toBe(true);
    expect(isFixSubject("fix!: drop the old flag")).toBe(true);
    expect(isFixSubject('Revert "feat: add x"')).toBe(true);
    expect(isFixSubject("Fixes a crash on empty input")).toBe(true);
    expect(isFixSubject("feat(core): add a prefix filter")).toBe(false);
    expect(isFixSubject("docs: explain the fixture layout")).toBe(false);
  });
});

describe("isMinedPath", () => {
  it("keeps source and leaves out docs, tests and data", () => {
    expect(isMinedPath("packages/core/src/run.ts")).toBe(true);
    expect(isMinedPath("scripts/lib/gate.mjs")).toBe(true);
    for (const path of [
      "README.md",
      "docs/manual/en/x.mdx",
      "packages/core/src/run.test.ts",
      "packages/core/src/run.e2e.test.ts",
      "package-lock.json",
      "src/__snapshots__/a.ts.snap",
      "tests/helpers.py",
      ".changeset/x.md",
      "CHANGELOG.md",
    ]) {
      expect(isMinedPath(path), path).toBe(false);
    }
  });
});
