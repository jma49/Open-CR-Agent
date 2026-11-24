import { describe, expect, it } from "vitest";
import { compareVersions, parseFeatures } from "./probe.js";

describe("parseFeatures", () => {
  it("reads each feature's name from codex features list", () => {
    const out = [
      "apps                                     stable             true",
      "shell_tool                               stable             true",
      "apply_patch_freeform                     removed            false",
      "",
      "WARNING: proceeding, even though we could not create PATH aliases",
    ].join("\n");
    expect([...parseFeatures(out)]).toEqual(["apps", "shell_tool", "apply_patch_freeform"]);
  });
});

describe("compareVersions", () => {
  it("orders versions part by part, as numbers", () => {
    expect(compareVersions("0.172.0", "0.172.0")).toBe(0);
    expect(compareVersions("0.99.9", "0.172.0")).toBe(-1);
    expect(compareVersions("1.0.0", "0.172.3")).toBe(1);
  });
});
