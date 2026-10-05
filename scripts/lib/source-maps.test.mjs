import { describe, expect, it } from "vitest";
import { danglingSourceMaps } from "./source-maps.mjs";

describe("danglingSourceMaps", () => {
  it("names a published file whose source map comment points at a file the package lacks", () => {
    const files = new Map([
      ["dist/index.js", "export const a = 1;\n//# sourceMappingURL=index.js.map\n"],
      ["dist/index.d.ts", "export declare const a = 1;\n//# sourceMappingURL=index.d.ts.map\n"],
      ["package.json", "{}"],
    ]);
    expect(danglingSourceMaps(files)).toEqual([
      "dist/index.js -> dist/index.js.map",
      "dist/index.d.ts -> dist/index.d.ts.map",
    ]);
  });

  it("accepts a map that is published beside its file, and files with no map comment", () => {
    const files = new Map([
      ["dist/a.js", "x;\n//# sourceMappingURL=a.js.map\n"],
      ["dist/a.js.map", "{}"],
      ["dist/b.js", "y;\n"],
    ]);
    expect(danglingSourceMaps(files)).toEqual([]);
  });

  it("resolves a relative map path and ignores inline data URLs", () => {
    const files = new Map([
      ["dist/sub/c.js", "z;\n//# sourceMappingURL=../maps/c.js.map\n"],
      ["dist/d.js", "w;\n//# sourceMappingURL=data:application/json;base64,e30=\n"],
    ]);
    expect(danglingSourceMaps(files)).toEqual(["dist/sub/c.js -> dist/maps/c.js.map"]);
  });
});
