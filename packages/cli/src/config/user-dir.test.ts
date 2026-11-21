import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ocraCacheDir } from "./user-dir.js";

describe.skipIf(process.platform === "win32")("ocraCacheDir", () => {
  it("takes OCRA_CACHE_DIR first, then XDG_CACHE_HOME, then ~/.cache", () => {
    expect(ocraCacheDir({ OCRA_CACHE_DIR: "/ci/cache", XDG_CACHE_HOME: "/xdg" })).toBe("/ci/cache");
    expect(ocraCacheDir({ XDG_CACHE_HOME: "/xdg" })).toBe(join("/xdg", "ocra"));
    expect(ocraCacheDir({})).toBe(join(homedir(), ".cache", "ocra"));
  });
});
