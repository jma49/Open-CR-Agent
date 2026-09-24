import { describe, expect, it } from "vitest";
import { parseJsonAnswer } from "./helpers.js";

describe("parseJsonAnswer", () => {
  it("reads bare, fenced and surrounded JSON", () => {
    expect(parseJsonAnswer('[{"label":"a","files":[0]}]')).toEqual([{ label: "a", files: [0] }]);
    expect(parseJsonAnswer('```json\n[{"label":"a","files":[0]}]\n```')).toEqual([
      { label: "a", files: [0] },
    ]);
    expect(parseJsonAnswer('Here are the groups:\n[{"label":"a","files":[0]}]\nDone.')).toEqual([
      { label: "a", files: [0] },
    ]);
  });

  it("rejects answers without JSON", () => {
    expect(() => parseJsonAnswer("I cannot group these files.")).toThrow(
      "the model answered without JSON",
    );
  });
});
