import { describe, expect, it } from "vitest";
import { languageOf } from "./languages.js";
import { parseSymbols } from "./parse.js";

describe("parseSymbols", () => {
  it("gives up on a file it cannot parse within its budget", async () => {
    const spec = languageOf("data.ts");
    if (!spec) throw new Error("no TypeScript");
    const content = `export function f() { return [${"1,".repeat(200_000)}]; }\n`;
    expect(await parseSymbols(spec, content, 0)).toBeUndefined();
    const next = await parseSymbols(spec, "export function g() {}\n");
    expect(next?.definitions.map((d) => d.name)).toEqual(["g"]);
  });
});
