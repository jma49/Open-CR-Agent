import { describe, expect, it } from "vitest";
import { GATEWAY_PATH, modelPriceSchema, providerEntrySchema } from "./providers.js";

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

describe("a model price", () => {
  it("is dollars per million tokens, with cached input optional", () => {
    expect(modelPriceSchema.parse({ input: 2, output: 10 })).toEqual({ input: 2, output: 10 });
    expect(modelPriceSchema.parse({ input: 2, output: 10, cachedInput: 0.1 }).cachedInput).toBe(
      0.1,
    );
  });

  it("is never negative, infinite or text", () => {
    for (const price of [
      { input: -1, output: 1 },
      { input: 1, output: Number.POSITIVE_INFINITY },
      { input: "1", output: 1 },
      { input: 1 },
      { input: 1, output: 1, cachedInput: -0.1 },
    ]) {
      expect(modelPriceSchema.safeParse(price).success).toBe(false);
    }
  });

  it("travels in a provider entry by model id, checked one by one where it is used", () => {
    const entry = providerEntrySchema.parse({
      name: "anthropic",
      paths: ["/v1/messages"],
      prices: { a: { input: 1, output: 2 }, b: "free" },
    });
    expect(entry.prices).toEqual({ a: { input: 1, output: 2 }, b: "free" });
    expect(providerEntrySchema.parse({ name: "x", paths: [] }).prices).toBeUndefined();
  });
});
