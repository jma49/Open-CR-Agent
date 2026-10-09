import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  checkLane,
  laneOutputs,
  parseLanes,
  pickLane,
  rotation,
  seriesName,
} from "./eval-lanes.mjs";

const nemotron = "nvidia/nemotron-3-ultra-550b-a55b:free";

describe("the lanes file", () => {
  it("parses, and names each lane's series apart", () => {
    const lanes = parseLanes(
      JSON.parse(
        readFileSync(new URL("../../.github/eval-free-lanes.json", import.meta.url), "utf8"),
      ),
    );
    expect(lanes.map((lane) => `${lane.model}@${lane.ref}`)).toEqual([
      `${nemotron}@main`,
      `${nemotron}@feat/review-wrap-up-turn`,
      "thinkingmachines/inkling:free@main",
    ]);
    const series = lanes.map(seriesName);
    expect(new Set(series).size).toBe(lanes.length);
  });

  it("refuses an empty list and lanes without a model or ref", () => {
    expect(() => parseLanes({ lanes: [] })).toThrow("no lanes");
    expect(() => parseLanes({ lanes: [{ model: nemotron }] })).toThrow("a model and a ref");
  });
});

describe("checkLane", () => {
  it("accepts branches and OpenRouter models, a :free variant included", () => {
    expect(checkLane("vendor/some-model:free", "feat/review-wrap-up-turn", "full")).toEqual({
      model: "vendor/some-model:free",
      ref: "feat/review-wrap-up-turn",
      tier: "full",
    });
  });

  it("refuses refs that name a pull request, a ref namespace, a range or an option", () => {
    for (const ref of [
      "refs/pull/1/head",
      "pull/470/head",
      "refs/heads/main",
      "-x",
      "main..evil",
      "a//b",
      "a/",
      "a.lock",
      "a b",
      "main;id",
      "",
    ]) {
      expect(() => checkLane(nemotron, ref, "smoke"), ref).toThrow("not a branch name");
    }
  });

  it("refuses other models and tiers", () => {
    expect(() => checkLane("no-vendor", "main", "smoke")).toThrow("not an OpenRouter model");
    expect(() => checkLane("a/b c", "main", "smoke")).toThrow("not an OpenRouter model");
    expect(() => checkLane(nemotron, "main", "huge")).toThrow("tier must be");
  });
});

describe("series and outputs", () => {
  it("encodes model, ref and tier in a label part without @ in the slugs", () => {
    const lane = { model: "vendor/m-1.5:free", ref: "feat/x_y", tier: "smoke" };
    expect(seriesName(lane)).toBe("free-vendor-m-1-5-free@feat-x-y-smoke");
    expect(laneOutputs(lane)).toBe(
      "model=vendor/m-1.5:free\nref=feat/x_y\ntier=smoke\nseries=free-vendor-m-1-5-free@feat-x-y-smoke",
    );
  });
});

describe("pickLane", () => {
  const lanes = ["gone", "main", "next"].map((ref) => ({ model: nemotron, ref, tier: "smoke" }));

  it("takes the first lane whose branch exists and names those passed over", async () => {
    const asked = /** @type {string[]} */ ([]);
    const picked = await pickLane(lanes, async (ref) => {
      asked.push(ref);
      return ref !== "gone";
    });
    expect(picked).toEqual({ lane: lanes[1], passedOver: [lanes[0]] });
    expect(asked).toEqual(["gone", "main"]);
  });

  it("picks none when no branch exists", async () => {
    expect(await pickLane(lanes, async () => false)).toEqual({
      lane: undefined,
      passedOver: lanes,
    });
  });
});

describe("rotation", () => {
  const lanes = ["a", "b"].map((ref) => ({ model: nemotron, ref, tier: "smoke" }));
  /** @param {number} n */
  const day = (n) => new Date(Date.UTC(2026, 9, 5 + n, 1));
  /** @param {number} n @param {number} slot */
  const first = (n, slot) => rotation(lanes, day(n), slot)[0]?.ref;

  it("alternates the early run by day and gives the late run the other lane", () => {
    expect([first(0, 0), first(1, 0), first(2, 0)]).toEqual(
      first(0, 0) === "a" ? ["a", "b", "a"] : ["b", "a", "b"],
    );
    for (const n of [0, 1]) expect(first(n, 1)).not.toBe(first(n, 0));
  });

  it("keeps every lane, as a fallback when the first one's branch is gone", () => {
    expect(
      rotation(lanes, day(0), 1)
        .map((l) => l.ref)
        .sort(),
    ).toEqual(["a", "b"]);
    expect(rotation(lanes.slice(0, 1), day(3), 1)).toEqual(lanes.slice(0, 1));
  });

  it("with three lanes, starts each day's early run on another lane and the late run on the next", () => {
    const three = ["a", "b", "c"].map((ref) => ({ model: nemotron, ref, tier: "smoke" }));
    /** @param {number} n @param {number} slot */
    const firstOf = (n, slot) => rotation(three, day(n), slot)[0]?.ref;
    expect([0, 1, 2].map((n) => firstOf(n, 0)).sort()).toEqual(["a", "b", "c"]);
    expect([0, 1, 2].map((n) => firstOf(n, 1)).sort()).toEqual(["a", "b", "c"]);
    for (const n of [0, 1, 2]) expect(firstOf(n, 1)).toBe(firstOf(n + 1, 0));
  });
});
