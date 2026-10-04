import { describe, expect, it } from "vitest";
import { shortHash } from "./hash.js";

describe("shortHash", () => {
  it("is the first sixteen hex characters of the text's SHA-256", () => {
    expect(shortHash("")).toBe("e3b0c44298fc1c14");
    expect(shortHash("ocra")).toMatch(/^[0-9a-f]{16}$/);
  });
});
