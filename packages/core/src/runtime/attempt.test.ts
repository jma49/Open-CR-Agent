import { describe, expect, it } from "vitest";
import { withoutSecrets } from "./attempt.js";

describe("withoutSecrets", () => {
  it("replaces every secret wherever it appears, and nothing else", () => {
    expect(
      withoutSecrets("HTTP 401: key sk-one rejected; sk-two also sk-one", ["sk-one", "sk-two"]),
    ).toBe("HTTP 401: key <key> rejected; <key> also <key>");
    expect(withoutSecrets("plain", [])).toBe("plain");
  });
});
