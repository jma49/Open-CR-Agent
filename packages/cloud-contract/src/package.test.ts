import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import pkg from "../package.json" with { type: "json" };

// ocra Cloud runs this package on Cloudflare Workers, as a copy until it
// installs it from npm: nothing but Zod, and nothing of Node.js.
describe("the contract package", () => {
  it("depends on Zod alone", () => {
    expect(Object.keys(pkg.dependencies)).toEqual(["zod"]);
  });

  it("imports nothing but Zod and its own modules", () => {
    const dir = new URL("./", import.meta.url);
    const sources = readdirSync(dir).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
    for (const file of sources) {
      const text = readFileSync(new URL(file, dir), "utf8");
      const imports = [...text.matchAll(/from "([^"]+)"/g)].map((m) => m[1]);
      expect(
        imports.filter((i) => i !== "zod" && !i?.startsWith("./")),
        file,
      ).toEqual([]);
    }
  });
});
