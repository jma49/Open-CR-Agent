import { describe, expect, it } from "vitest";
import { binaryVariants } from "./binary.js";

const host = { platform: "linux", arch: "x64", musl: false, baseline: false };

describe("binaryVariants", () => {
  it("tries the default build first on glibc x64 with AVX2", () => {
    expect(binaryVariants(host)).toEqual(["", "-baseline", "-musl", "-baseline-musl"]);
  });

  it("tries the musl builds first on musl Linux, where npm installs the glibc builds too", () => {
    expect(binaryVariants({ ...host, musl: true })).toEqual([
      "-musl",
      "-baseline-musl",
      "",
      "-baseline",
    ]);
    expect(binaryVariants({ ...host, arch: "arm64", musl: true })).toEqual(["-musl", ""]);
  });

  it("tries the baseline build first on x64 without AVX2", () => {
    expect(binaryVariants({ ...host, baseline: true })).toEqual([
      "-baseline",
      "",
      "-baseline-musl",
      "-musl",
    ]);
    expect(binaryVariants({ ...host, platform: "darwin", baseline: true })).toEqual([
      "-baseline",
      "",
    ]);
  });

  it("has one build on arm64 outside Linux", () => {
    expect(binaryVariants({ ...host, platform: "darwin", arch: "arm64" })).toEqual([""]);
    expect(binaryVariants({ ...host, platform: "windows", arch: "arm64" })).toEqual([""]);
  });
});
