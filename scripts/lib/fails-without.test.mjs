import { describe, expect, it } from "vitest";
import { failsWithoutVerdict } from "./fails-without.mjs";

// Shortened vitest 5 output.
const NO_FILES = ` RUN  v5.0.2 /repo

No test files found, exiting with code 1

filter: scripts/lib/no-such.test.mjs

|unit|
include: packages/*/src/**/*.test.ts, scripts/**/*.test.mjs
`;

const ASSERTION_FAILED = ` RUN  v5.0.2 /repo

 ❯ |unit| scripts/lib/pins.test.mjs (8 tests | 1 failed) 9ms
     × finds the README 3ms
AssertionError: expected false to be true

 Test Files  1 failed (1)
      Tests  1 failed | 7 passed (8)
`;

const IMPORT_FAILED = ` FAIL  |unit| scripts/lib/pins.test.mjs [ scripts/lib/pins.test.mjs ]
SyntaxError: The requested module './pins.mjs' does not provide an export named 'recipeFiles'

 Test Files  1 failed (1)
      Tests  no tests
`;

const COLLECTION_FAILED = ` FAIL  |unit| scripts/lib/pins.test.mjs [ scripts/lib/pins.test.mjs ]
TypeError: Cannot read properties of undefined (reading 'split')

 Test Files  1 failed (1)
      Tests  no tests
`;

describe("failsWithoutVerdict", () => {
  it("accepts a test that fails on an assertion", () => {
    const verdict = failsWithoutVerdict(1, ASSERTION_FAILED);
    expect(verdict.ok).toBe(true);
    expect(verdict.details).toContain("      Tests  1 failed | 7 passed (8)");
  });

  it("refuses a filter that matches no test file, which vitest also exits 1 on", () => {
    expect(failsWithoutVerdict(1, NO_FILES)).toEqual({
      ok: false,
      message: "NO TEST RAN: the filter matches no test file; name the test file",
      details: ["filter: scripts/lib/no-such.test.mjs"],
    });
  });

  it("refuses a test that passes", () => {
    expect(failsWithoutVerdict(0, " Tests  8 passed (8)\n").message).toMatch(/^PASSES/);
  });

  it("refuses a test that fails only because it cannot load", () => {
    const verdict = failsWithoutVerdict(1, IMPORT_FAILED);
    expect(verdict.ok).toBe(false);
    expect(verdict.message).toMatch(/^FAILS ONLY AT IMPORT/);
  });

  it("refuses a run in which no test failed", () => {
    const verdict = failsWithoutVerdict(1, COLLECTION_FAILED);
    expect(verdict.ok).toBe(false);
    expect(verdict.message).toMatch(/^NO TEST FAILED/);
  });
});
