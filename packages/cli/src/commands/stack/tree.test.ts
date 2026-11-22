import { describe, expect, it } from "vitest";
import type { StackLink } from "./links.js";
import { depthOf, foldMerged, stackOf } from "./tree.js";

const on = (parent: string, parentHead = `${parent}-head`): StackLink => ({ parent, parentHead });

const links = new Map<string, StackLink>([
  ["c", on("b")],
  ["a", on("main")],
  ["b2", on("a")],
  ["b", on("a")],
  ["other", on("main")],
]);

describe("stackOf", () => {
  it("orders the tree that holds a branch parents first, siblings by name", () => {
    expect(stackOf(links, "c")).toEqual(["a", "b", "c", "b2"]);
    expect(stackOf(links, "a")).toEqual(["a", "b", "c", "b2"]);
    expect(stackOf(links, "other")).toEqual(["other"]);
  });

  it("is empty for a branch in no stack and survives a cycle", () => {
    expect(stackOf(links, "main")).toEqual([]);
    const cycle = new Map([
      ["x", on("y")],
      ["y", on("x")],
    ]);
    expect(stackOf(cycle, "x").sort()).toEqual(["x", "y"]);
  });

  it("counts a branch's depth above the trunk", () => {
    expect(depthOf(links, "a")).toBe(0);
    expect(depthOf(links, "c")).toBe(2);
  });
});

describe("foldMerged", () => {
  it("moves a child onto its nearest unmerged ancestor, built on the merged parent's tip", () => {
    const folded = foldMerged(
      links,
      new Set(["a", "b"]),
      new Map([
        ["a", "a-tip"],
        ["b", "b-tip"],
      ]),
    );
    expect(folded.get("c")).toEqual({ parent: "main", parentHead: "b-tip" });
    expect(folded.get("b2")).toEqual({ parent: "main", parentHead: "a-tip" });
    expect(folded.get("other")).toEqual(on("main"));
    expect(folded.has("a")).toBe(false);
  });
});
