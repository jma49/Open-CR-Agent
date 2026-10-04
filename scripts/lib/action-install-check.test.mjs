import { describe, expect, it } from "vitest";
import { installOutcome } from "./action-install-check.mjs";

const temp = "/runner/temp";

describe("installOutcome", () => {
  it("accepts an install from npm, and any install from source asked for", () => {
    expect(
      installOutcome({ install: "npm", main: `${temp}/ocra-cli/main.js`, temp, source: "" }),
    ).toBeUndefined();
    expect(
      installOutcome({ install: "source", main: "/work/main.js", temp, source: "" }),
    ).toBeUndefined();
  });

  it("accepts a build from source while the version is unpublished or declares other dependencies", () => {
    for (const source of ["unpublished", "dependencies"]) {
      expect(installOutcome({ install: "npm", main: "/work/main.js", temp, source })).toEqual({
        note: `Built from source: ${source}`,
      });
    }
  });

  it("fails a build from source for any other reason", () => {
    expect(
      installOutcome({ install: "npm", main: "/work/main.js", temp, source: "provenance" }),
    ).toEqual({
      error: "the Action built from source (provenance) instead of installing from npm",
    });
  });
});
