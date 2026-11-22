import { readFileSync } from "node:fs";
import { relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { manualPages } from "./manual-pins.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));

// The site parses each page's front matter as YAML and fails its build on
// one it cannot read, such as an unquoted value holding ": ".
describe("the manual's front matter", () => {
  for (const page of manualPages(root)) {
    it(`${relative(root, page)} is YAML with a title and a description`, () => {
      const match = /^---\n([\s\S]*?)\n---\n/.exec(readFileSync(page, "utf8"));
      expect(match).not.toBeNull();
      const data = parse(match?.[1] ?? "");
      expect(typeof data.title).toBe("string");
      expect(typeof data.description).toBe("string");
    });
  }
});
