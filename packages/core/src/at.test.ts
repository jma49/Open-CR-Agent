import { describe, expect, it } from "vitest";
import { at } from "./at.js";
import { isOcraError } from "./errors.js";

describe("at", () => {
  it("returns the element at an index inside the list", () => {
    expect(at(["a", "b"], 1)).toBe("b");
    expect(at("xy", 0)).toBe("x");
    expect(at([undefined], 0)).toBeUndefined();
  });

  it.each([-1, 2, 0.5])("throws an internal error for index %s", (index) => {
    const error = (() => {
      try {
        at(["a", "b"], index);
      } catch (e) {
        return e;
      }
      return undefined;
    })();
    expect(isOcraError(error, "INTERNAL")).toBe(true);
  });
});
