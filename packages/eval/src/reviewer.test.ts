import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { defaultOcraCommand } from "./reviewer.js";

describe("defaultOcraCommand", () => {
  it("points at the built ocra CLI", () => {
    const [node, main] = defaultOcraCommand();
    expect(node).toBe(process.execPath);
    expect(main).toMatch(/cli[/\\]dist[/\\]main\.js$/);
    expect(existsSync(main as string)).toBe(true);
  });
});
