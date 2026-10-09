import { describe, expect, it } from "vitest";
import { GATEWAY_PATH } from "./providers.js";

describe("a gateway path", () => {
  it("is one or more plain segments", () => {
    for (const path of ["/v1/chat/completions", "/chat/completions", "/v1beta/openai/x.y_z-1"]) {
      expect(GATEWAY_PATH.test(path)).toBe(true);
    }
  });

  it("has no dot segment, which would leave the provider's prefix once resolved", () => {
    for (const path of [
      "/../chat/completions",
      "/v1/../../chat/completions",
      "/./chat",
      "/v1/..",
    ]) {
      expect(GATEWAY_PATH.test(path)).toBe(false);
    }
  });

  it("has no empty segment", () => {
    for (const path of ["/", "//chat/completions", "/v1//chat", "/v1/"]) {
      expect(GATEWAY_PATH.test(path)).toBe(false);
    }
  });

  it("keeps dots inside a segment", () => {
    expect(GATEWAY_PATH.test("/v1/.well-known/x")).toBe(true);
    expect(GATEWAY_PATH.test("/v1/...")).toBe(true);
  });
});
