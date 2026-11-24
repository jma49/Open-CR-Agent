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
    expect(mendResultSchema.parse(committed)).toEqual({
      ...committed,
      mergeParent: null,
      items: [
        {
          ...committed.items[0],
          cause: null,
          check: null,
          conflict: null,
          resolved: null,
          regions: [],
        },
      ],
    });
    expect(mendResultSchema.safeParse({ ...committed, commitSha: null }).success).toBe(false);
    expect(mendResultSchema.safeParse({ ...committed, outcome: "proposed" }).success).toBe(false);
    const stopped = { ...committed, outcome: "stopped", commitSha: null, items: [] };
    expect(mendResultSchema.safeParse({ ...stopped, stopped: "rounds" }).success).toBe(true);
    expect(mendResultSchema.safeParse(stopped).success).toBe(false);
    expect(mendResultSchema.safeParse({ ...committed, stopped: "spend" }).success).toBe(false);
  });

  it("takes a failed check as an item, and a round that waits for the checks", () => {
    const check = { ...committed.items[0], check: "test (node 22)" };
    expect(mendResultSchema.parse({ ...committed, items: [check] }).items[0]?.check).toBe(
      "test (node 22)",
    );
    const waiting = { ...committed, outcome: "waiting", commitSha: null, items: [] };
    expect(mendResultSchema.safeParse(waiting).success).toBe(true);
  });

  it("takes a merge conflict as an item, with its file only when proposed", () => {
    const conflict = {
      fingerprint: "b491fb26b470419c",
      conflict: "src/a.ts",
      reason: null,
      edits: [],
    };
    const merged = { ...committed, mergeParent: "d".repeat(40) };
    const withItem = (item: object, more: object = {}) =>
      mendResultSchema.safeParse({ ...merged, ...more, items: [{ ...conflict, ...item }] }).success;
    expect(withItem({ outcome: "fixed" })).toBe(true);
    expect(withItem({ outcome: "fixed", resolved: "x\n" })).toBe(false);
    const proposed = { outcome: "proposed", commitSha: null };
    expect(withItem({ outcome: "proposed", resolved: "x\n" }, proposed)).toBe(true);
    expect(withItem({ outcome: "proposed" }, proposed)).toBe(false);
    expect(withItem({ outcome: "deferred", reason: "conflicts" })).toBe(true);
    expect(withItem({ outcome: "deferred", reason: "conflicts", resolved: "x" })).toBe(false);
    const regions = [{ line: 1, ours: "a", theirs: "b", resolved: "x" }];
    expect(withItem({ outcome: "proposed", resolved: "x\n", regions }, proposed)).toBe(true);
    expect(withItem({ outcome: "fixed", regions })).toBe(false);
    expect(
      withItem({ outcome: "proposed", resolved: "x\n", regions: [{ line: 0 }] }, proposed),
    ).toBe(false);
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

  it("says what failed only for a finding whose call failed", () => {
    const failed = { ...committed.items[0], outcome: "rejected", reason: "failed", edits: [] };
    const withItem = (changed: object) => ({ ...committed, items: [{ ...failed, ...changed }] });
    expect(mendResultSchema.parse(withItem({ cause: "quota" })).items[0]?.cause).toBe("quota");
    expect(mendResultSchema.parse(withItem({})).items[0]?.cause).toBeNull();
    expect(
      mendResultSchema.safeParse(withItem({ reason: "unresolved", cause: "quota" })).success,
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
