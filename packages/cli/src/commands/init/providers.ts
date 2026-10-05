import { UsageError } from "../../io/usage-error.js";

// The providers ocra init can set up on its own. A provider runs on the
// direct runtime only once a review has run live through it that way;
// until then it runs on OpenCode, the default, which prices its catalog's
// models itself.

interface Tiers {
  top: string;
  standard: string;
  light: string;
}

interface CatalogProvider {
  runtime: "opencode";
  name: string;
  label: string;
  keyEnv: string;
  // OpenCode catalog ids, provider/model.
  models: Tiers;
}

interface DirectProvider {
  runtime: "direct";
  name: string;
  label: string;
  keyEnv: string;
  // The id declared under providers: none OpenCode's catalog uses, since a
  // declared provider replaces a known one of the same id.
  id: string;
  baseUrl: string;
  model: string;
}

export type ProviderPreset = CatalogProvider | DirectProvider;

const GEMINI: CatalogProvider = {
  runtime: "opencode",
  name: "gemini",
  label: "Gemini models",
  keyEnv: "GEMINI_API_KEY",
  models: {
    top: "google/gemini-3.1-pro-preview",
    standard: "google/gemini-3.5-flash",
    light: "google/gemini-flash-lite-latest",
  },
};

const ANTHROPIC: CatalogProvider = {
  runtime: "opencode",
  name: "anthropic",
  label: "Anthropic models",
  keyEnv: "ANTHROPIC_API_KEY",
  models: {
    top: "anthropic/claude-opus-5-5",
    standard: "anthropic/claude-sonnet-5-5",
    light: "anthropic/claude-haiku-4-5",
  },
};

const OPENAI: CatalogProvider = {
  runtime: "opencode",
  name: "openai",
  label: "OpenAI models",
  keyEnv: "OPENAI_API_KEY",
  models: { top: "openai/gpt-6-sol", standard: "openai/gpt-6-sol", light: "openai/gpt-6-luna" },
};

// The free preview the project's own reviews run on through the direct
// runtime; a preview can move, which the manual says (Model providers,
// Free models through OpenRouter).
const OPENROUTER: DirectProvider = {
  runtime: "direct",
  name: "openrouter",
  label: "OpenRouter's free model",
  keyEnv: "OPENROUTER_API_KEY",
  id: "router",
  baseUrl: "https://openrouter.ai/api/v1",
  model: "stealth/space-bunny-alpha",
};

// In the order a key found in the environment is preferred: the free model
// only when no paid key is there.
export const PRESETS: readonly ProviderPreset[] = [GEMINI, ANTHROPIC, OPENAI, OPENROUTER];

export type Choice = { preset: ProviderPreset; found: "flag" | "environment"; others: string[] };

type Env = Readonly<Record<string, string | undefined>>;

export function chooseProvider(flag: string | undefined, env: Env): Choice {
  if (flag !== undefined) {
    const preset = PRESETS.find((p) => p.name === flag);
    if (!preset) {
      throw new UsageError(
        `Unknown provider "${flag}": use one of ${PRESETS.map((p) => p.name).join(", ")}`,
      );
    }
    return { preset, found: "flag", others: [] };
  }
  const present = PRESETS.filter((p) => env[p.keyEnv]?.trim());
  const [preset, ...rest] = present;
  if (!preset) {
    throw new UsageError(
      `No model key in the environment: set ${keyList()}, or pass --provider ${PRESETS.map((p) => p.name).join("|")}`,
    );
  }
  return { preset, found: "environment", others: rest.map((p) => p.keyEnv) };
}

function keyList(): string {
  const keys = PRESETS.map((p) => p.keyEnv);
  return `${keys.slice(0, -1).join(", ")} or ${keys.at(-1)}`;
}

const SCHEMA_URL =
  "https://raw.githubusercontent.com/jma49/Open-CR-Agent/main/docs/schema/config.v1.json";

// The smallest .ocra/config.json that reviews with the preset: on OpenCode,
// models by tier; on the direct runtime, also the one endpoint they are on,
// with the model's price (0, a free model).
export function configFor(preset: ProviderPreset): string {
  const config =
    preset.runtime === "opencode"
      ? { $schema: SCHEMA_URL, models: preset.models }
      : {
          $schema: SCHEMA_URL,
          runtime: "direct",
          models: Object.fromEntries(
            ["top", "standard", "light"].map((tier) => [tier, `${preset.id}/${preset.model}`]),
          ),
          providers: {
            [preset.id]: {
              type: "openai-compatible",
              baseUrl: preset.baseUrl,
              apiKeyEnv: preset.keyEnv,
              models: { [preset.model]: { input: 0, output: 0 } },
            },
          },
        };
  return `${JSON.stringify(config, null, 2)}\n`;
}
