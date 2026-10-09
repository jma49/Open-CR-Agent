import { describe, expect, it } from "vitest";
import { sealLine, unsealLine } from "./seal.js";

const KEY = "ab".repeat(32);

describe("sealLine", () => {
  it("seals a serialized object so that unsealLine gives it back", () => {
    const line = '{"type":"run_started"}';
    const sealed = sealLine(KEY, "r1", line);
    expect(JSON.parse(sealed)).toMatchObject({ type: "run_started" });
    expect(unsealLine(KEY, "r1", sealed)).toBe(line);
  });

  it("refuses a line that is not a serialized object", () => {
    for (const line of ['["a"]', '{"a":1}\n', "1"]) {
      expect(() => sealLine(KEY, "r1", line)).toThrow(/not a serialized JSON object/);
    }
  });
});
