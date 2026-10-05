import { describe, expect, it } from "vitest";
import { attemptRecord, exploredBy, withoutSecrets } from "./attempt.js";

describe("withoutSecrets", () => {
  it("replaces every secret wherever it appears, and nothing else", () => {
    expect(
      withoutSecrets("HTTP 401: key sk-one rejected; sk-two also sk-one", ["sk-one", "sk-two"]),
    ).toBe("HTTP 401: key <key> rejected; <key> also <key>");
    expect(withoutSecrets("plain", [])).toBe("plain");
  });
});

describe("exploredBy", () => {
  it("keeps each file read once and every literal searched, in order, and ignores other tools", () => {
    expect(
      exploredBy([
        { name: "read_file", input: { path: "b.ts" } },
        { name: "code_search", input: { literal: "parse(" } },
        { name: "read_file", input: { path: "a.ts", startLine: 200 } },
        { name: "read_file", input: { path: "b.ts", startLine: 400 } },
        { name: "read_diff", input: { path: "c.ts" } },
        { name: "read_file", input: "not an object" },
      ]),
    ).toEqual({ read: ["b.ts", "a.ts"], searched: ["parse("] });
  });

  it("bounds what a model chose: how many entries, and how long each and the text are", () => {
    const uses = Array.from({ length: 300 }, (_, i) => ({
      name: "read_file",
      input: { path: `${i}/${"d/".repeat(400)}a.ts` },
    }));
    const { read } = exploredBy(uses);
    expect(read).toHaveLength(200);
    expect(read.every((p) => p.length <= 501)).toBe(true);
    const record = attemptRecord("p/m", {
      findings: [],
      steps: 1,
      toolCalls: [],
      text: "x".repeat(10_000),
      usage: { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cachedTokens: 0, costUsd: 0 },
    });
    expect(record).toMatchObject({ model: "p/m", read: [], searched: [] });
    expect(record.text.length).toBeLessThanOrEqual(4_001);
  });

  it("keeps the end of a long answer, where the reviewer concludes", () => {
    const record = attemptRecord("p/m", {
      findings: [],
      steps: 1,
      toolCalls: [],
      text: `${"thinking ".repeat(1_000)}Conclusion: nothing to report.`,
      usage: { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cachedTokens: 0, costUsd: 0 },
    });
    expect(record.text.endsWith("Conclusion: nothing to report.")).toBe(true);
    expect(record.text.startsWith("…")).toBe(true);
  });
});
