import { describe, expect, it } from "vitest";
import { mendResultSchema, mendStateSchema } from "./mend.js";

const usage = { inputTokens: 1, cachedTokens: 0, outputTokens: 1, reasoningTokens: 0, costUsd: 0 };
const edit = { path: "src/a.ts", startLine: 3, endLine: 3, replacement: "  return n;" };
const state = { rounds: 1, costUsd: 0.06, items: { b491fb26b470419c: { attempts: 1 } } };
const committed = {
  headSha: "a".repeat(40),
  outcome: "committed",
  stopped: null,
  commitSha: "c".repeat(40),
  items: [{ fingerprint: "b491fb26b470419c", outcome: "fixed", reason: null, edits: [edit] }],
  state,
  usage,
} as const;

describe("ocra mend's result", () => {
  it("names a commit only when one was written, and a stop only when stopped", () => {
    expect(mendResultSchema.parse(committed)).toEqual(committed);
    expect(mendResultSchema.safeParse({ ...committed, commitSha: null }).success).toBe(false);
    expect(mendResultSchema.safeParse({ ...committed, outcome: "proposed" }).success).toBe(false);
    const stopped = { ...committed, outcome: "stopped", commitSha: null, items: [] };
    expect(mendResultSchema.safeParse({ ...stopped, stopped: "rounds" }).success).toBe(true);
    expect(mendResultSchema.safeParse(stopped).success).toBe(false);
    expect(mendResultSchema.safeParse({ ...committed, stopped: "spend" }).success).toBe(false);
  });

  it("holds edits for a fixed or proposed finding, and for no other", () => {
    const item = committed.items[0];
    const withItem = (changed: object) => ({ ...committed, items: [{ ...item, ...changed }] });
    expect(mendResultSchema.safeParse(withItem({ edits: [] })).success).toBe(false);
    expect(
      mendResultSchema.safeParse(withItem({ outcome: "rejected", reason: "unresolved" })).success,
    ).toBe(false);
    expect(
      mendResultSchema.safeParse(withItem({ outcome: "rejected", reason: "unresolved", edits: [] }))
        .success,
    ).toBe(true);
    expect(
      mendResultSchema.safeParse(withItem({ edits: [{ ...edit, startLine: 4 }] })).success,
    ).toBe(false);
  });

  it("refuses an unknown outcome or reason, and a state that is not one", () => {
    expect(mendResultSchema.safeParse({ ...committed, outcome: "merged" }).success).toBe(false);
    const item = { ...committed.items[0], outcome: "rejected", reason: "bored", edits: [] };
    expect(mendResultSchema.safeParse({ ...committed, items: [item] }).success).toBe(false);
    expect(mendStateSchema.safeParse({ ...state, rounds: -1 }).success).toBe(false);
    expect(
      mendStateSchema.safeParse({ ...state, items: { x: { attempts: 1, closed: "done" } } })
        .success,
    ).toBe(false);
    expect(
      mendStateSchema.parse({ ...state, items: { abcd: { attempts: 2, closed: "gone" } } }).items,
    ).toEqual({ abcd: { attempts: 2, closed: "gone" } });
  });
});
