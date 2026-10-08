import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { renderDiagrams } from "./diagrams.mjs";

const images = join(import.meta.dirname, "..", "..", "docs", "images");

describe("README diagrams", () => {
  it("are current: run node scripts/diagrams.mjs after changing them", () => {
    for (const [name, svg] of renderDiagrams()) {
      expect(readFileSync(join(images, name), "utf8"), name).toBe(svg);
    }
  });

  it("draw both languages in both themes, with no script or outside reference", () => {
    const files = renderDiagrams();
    expect([...files.keys()].sort()).toEqual(
      ["agents", "system"].flatMap((d) =>
        ["en", "zh"].flatMap((l) => [`${d}-${l}-dark.svg`, `${d}-${l}-light.svg`]),
      ),
    );
    for (const svg of files.values()) {
      expect(svg).not.toMatch(/<script|href="http/);
    }
  });
});
