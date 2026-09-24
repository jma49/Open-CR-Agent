import { describe, expect, it } from "vitest";
import { run } from "./run.js";

function capture() {
  let text = "";
  return { write: (chunk: string) => (text += chunk), text: () => text };
}

describe("run", () => {
  it("prints the version", async () => {
    const out = capture();
    expect(await run(["--version"], out, capture())).toBe(0);
    expect(out.text()).toBe("0.0.0\n");
  });

  it("prints usage without a command", async () => {
    const out = capture();
    expect(await run([], out, capture())).toBe(0);
    expect(out.text()).toContain("Usage: ocra");
  });

  it("rejects unknown commands", async () => {
    const err = capture();
    expect(await run(["nope"], capture(), err)).toBe(2);
    expect(err.text()).toContain("Unknown command: nope");
  });
});
