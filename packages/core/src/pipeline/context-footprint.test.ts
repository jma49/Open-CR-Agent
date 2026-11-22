import { describe, expect, it } from "vitest";
import { ocraText } from "../review/prompt-text.js";
import { contextFootprint } from "./context-footprint.js";

const line = (word: string) => `${word} `.repeat(12);

describe("contextFootprint", () => {
  it("counts each source's tokens, in prompt order", () => {
    expect(
      contextFootprint([
        { source: "system", text: ocraText("x".repeat(8)) },
        { source: "diff", text: ocraText("y".repeat(9)) },
      ]),
    ).toEqual([
      { source: "system", tokens: 2 },
      { source: "diff", tokens: 3 },
    ]);
  });

  it("counts texts held to a limit and lists cut short", () => {
    const [part] = contextFootprint([
      { source: "guidelines", text: ocraText("text\n[truncated]\nand 12 more changed files.") },
    ]);
    expect(part?.cut).toBe(2);
  });

  it("counts long lines an earlier part already holds, not short ones", () => {
    const repeated = line("guideline");
    const parts = contextFootprint([
      { source: "guidelines", text: ocraText(`${repeated}\n}`) },
      { source: "project_docs", text: ocraText(`${repeated}\n}\n${line("design")}`) },
    ]);
    expect(parts[0]?.duplicateTokens).toBeUndefined();
    expect(parts[1]?.duplicateTokens).toBe(Math.ceil(repeated.trim().length / 4));
  });
});
