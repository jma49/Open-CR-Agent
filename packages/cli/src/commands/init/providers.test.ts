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
  it.each(PRESETS.map((p) => [p.name, p] as const))("%s: a valid configuration", (_, preset) => {
    configSchema.parse(JSON.parse(configFor(preset)));
  });

  it.each([
    [
      "gemini",
      "google/gemini-3.1-pro-preview",
      "google/gemini-3.5-flash",
      "google/gemini-flash-lite-latest",
    ],
    [
      "anthropic",
      "anthropic/claude-opus-5-5",
      "anthropic/claude-sonnet-5-5",
      "anthropic/claude-haiku-4-5",
    ],
    ["openai", "openai/gpt-6-sol", "openai/gpt-6-sol", "openai/gpt-6-luna"],
  ])(
    "%s: OpenCode's catalog models on the default runtime, priced by the catalog",
    (name, top, standard, light) => {
      const config = JSON.parse(configFor(chooseProvider(name, {}).preset));
      expect(config).toEqual({
        $schema:
          "https://raw.githubusercontent.com/jma49/Open-CR-Agent/main/docs/schema/config.v1.json",
        models: { top, standard, light },
      });
    },
  );

  it("puts OpenRouter's free router on the direct runtime, priced at 0", () => {
    expect(JSON.parse(configFor(chooseProvider("openrouter", {}).preset))).toEqual({
      $schema:
        "https://raw.githubusercontent.com/jma49/Open-CR-Agent/main/docs/schema/config.v1.json",
      runtime: "direct",
      models: {
        top: "router/openrouter/free",
        standard: "router/openrouter/free",
        light: "router/openrouter/free",
      },
      providers: {
        router: {
          type: "openai-compatible",
          baseUrl: "https://openrouter.ai/api/v1",
          apiKeyEnv: "OPENROUTER_API_KEY",
          models: { "openrouter/free": { input: 0, output: 0 } },
        },
      },
    });
  });
});
