import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { capture } from "./run.fakes.js";
import { run } from "./run.js";

describe("ocra", () => {
  it("prints the version and usage", async () => {
    const out = capture();
    expect(await run(["--version"], out, capture())).toBe(0);
    const { version } = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    );
    expect(out.text()).toBe(`${version}\n`);
    const usage = capture();
    expect(await run([], usage, capture())).toBe(0);
    expect(usage.text()).toContain("Usage: ocra");
  });

  it("rejects unknown commands and options", async () => {
    const err = capture();
    expect(await run(["nope"], capture(), err)).toBe(2);
    expect(err.text()).toContain("Unknown command: nope");
    expect(await run(["--nope"], capture(), capture())).toBe(2);
  });
});
