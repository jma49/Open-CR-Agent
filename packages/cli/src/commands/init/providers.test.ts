import { describe, expect, it } from "vitest";
import { configSchema } from "../../config/schema.js";
import { chooseProvider, configFor, PRESETS } from "./providers.js";

const KEYS = {
  GEMINI_API_KEY: "g",
  ANTHROPIC_API_KEY: "a",
  OPENAI_API_KEY: "o",
  OPENROUTER_API_KEY: "r",
};

describe("chooseProvider", () => {
  it.each([
    ["GEMINI_API_KEY", "gemini"],
    ["ANTHROPIC_API_KEY", "anthropic"],
    ["OPENAI_API_KEY", "openai"],
    ["OPENROUTER_API_KEY", "openrouter"],
  ])("takes the provider of %s when it is the only key", (key, name) => {
    const choice = chooseProvider(undefined, { [key]: "secret" });
    expect(choice.preset.name).toBe(name);
    expect(choice.others).toEqual([]);
  });

  it("prefers a paid key and names the others", () => {
    const choice = chooseProvider(undefined, KEYS);
    expect(choice.preset.name).toBe("gemini");
    expect(choice.others).toEqual(["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY"]);
    const { OPENAI_API_KEY, OPENROUTER_API_KEY } = KEYS;
    expect(chooseProvider(undefined, { OPENROUTER_API_KEY, OPENAI_API_KEY }).preset.name).toBe(
      "openai",
    );
  });

  it("ignores an empty key", () => {
    expect(
      chooseProvider(undefined, { GEMINI_API_KEY: " ", OPENROUTER_API_KEY: "r" }).preset.name,
    ).toBe("openrouter");
  });

  it("takes --provider over the environment, without a key", () => {
    const choice = chooseProvider("anthropic", { GEMINI_API_KEY: "g" });
    expect(choice).toMatchObject({ found: "flag", others: [] });
    expect(choice.preset.keyEnv).toBe("ANTHROPIC_API_KEY");
    expect(() => chooseProvider("google", {})).toThrow(
      'Unknown provider "google": use one of gemini, anthropic, openai, openrouter',
    );
  });

  it("says which keys it looks for when there is none", () => {
    expect(() => chooseProvider(undefined, {})).toThrow(
      "No model key in the environment: set GEMINI_API_KEY, ANTHROPIC_API_KEY, OPENAI_API_KEY or OPENROUTER_API_KEY, or pass --provider gemini|anthropic|openai|openrouter",
    );
  });
});

describe("configFor", () => {
  it.each(PRESETS.map((p) => [p.name, p] as const))(
    "%s: a valid configuration on the direct runtime, every model declared and priced",
    (_, preset) => {
      const text = configFor(preset);
      const config = configSchema.parse(JSON.parse(text));
      expect(config.runtime).toBe("direct");
      const provider = config.providers?.[preset.id];
      expect(Object.keys(config.providers ?? {})).toEqual([preset.id]);
      expect(provider).toMatchObject({ baseUrl: preset.baseUrl, apiKeyEnv: preset.keyEnv });
      for (const chain of [config.models.top, config.models.standard, config.models.light]) {
        expect(chain).toHaveLength(1);
        const [id, model] = (chain?.[0] ?? "").split(/\/(.*)/s);
        expect(id).toBe(preset.id);
        expect(provider?.models[model ?? ""]).toBeDefined();
      }
    },
  );

  it("writes Gemini's configuration as the manual shows it", () => {
    expect(JSON.parse(configFor(chooseProvider("gemini", {}).preset))).toEqual({
      $schema:
        "https://raw.githubusercontent.com/jma49/Open-CR-Agent/main/docs/schema/config.v1.json",
      runtime: "direct",
      models: {
        top: "gemini-api/gemini-3.1-pro-preview",
        standard: "gemini-api/gemini-3.5-flash",
        light: "gemini-api/gemini-flash-lite-latest",
      },
      providers: {
        "gemini-api": {
          type: "openai-compatible",
          baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
          apiKeyEnv: "GEMINI_API_KEY",
          models: {
            "gemini-3.1-pro-preview": { input: 2, output: 12, cachedInput: 0.2 },
            "gemini-3.5-flash": { input: 1.5, output: 9, cachedInput: 0.15 },
            "gemini-flash-lite-latest": { input: 0.3, output: 2.5, cachedInput: 0.03 },
          },
        },
      },
    });
  });

  it("uses OpenRouter's free model at a price of 0", () => {
    const config = JSON.parse(configFor(chooseProvider("openrouter", {}).preset));
    expect(config.models.standard).toBe("router/stealth/space-bunny-alpha");
    expect(config.providers.router.models).toEqual({
      "stealth/space-bunny-alpha": { input: 0, output: 0 },
    });
  });
});
