import { UsageError } from "../../io/usage-error.js";

// The providers ocra init can set up on its own: each an OpenAI-compatible
// endpoint the direct runtime calls, with a model per tier and its price.

interface Price {
  input: number;
  output: number;
  cachedInput?: number;
}

interface Model {
  id: string;
  price: Price;
}

export interface ProviderPreset {
  name: string;
  label: string;
  keyEnv: string;
  // The id declared under providers: none OpenCode's catalog uses, since a
  // declared provider replaces a known one of the same id.
  id: string;
  baseUrl: string;
  tiers: { top: Model; standard: Model; light: Model };
}

// List prices in US dollars per million tokens, from models.dev on
// 2026-10-04; the run's reported cost and --max-cost-usd count with them.
// Gemini 3.1 Pro and the GPT-6 models charge more for a prompt above
// 200k/272k tokens; a declared price is flat, so such a prompt is counted
// at the lower price.
const GEMINI: ProviderPreset = {
  name: "gemini",
  label: "Gemini models",
  keyEnv: "GEMINI_API_KEY",
  id: "gemini-api",
  baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
  tiers: {
    top: { id: "gemini-3.1-pro-preview", price: { input: 2, output: 12, cachedInput: 0.2 } },
    standard: { id: "gemini-3.5-flash", price: { input: 1.5, output: 9, cachedInput: 0.15 } },
    light: {
      id: "gemini-flash-lite-latest",
      price: { input: 0.3, output: 2.5, cachedInput: 0.03 },
    },
  },
};

const ANTHROPIC: ProviderPreset = {
  name: "anthropic",
  label: "Anthropic models",
  keyEnv: "ANTHROPIC_API_KEY",
  id: "anthropic-api",
  baseUrl: "https://api.anthropic.com/v1",
  tiers: {
    top: { id: "claude-opus-5-5", price: { input: 4, output: 20, cachedInput: 0.2 } },
    standard: { id: "claude-sonnet-5-5", price: { input: 2, output: 10, cachedInput: 0.2 } },
    light: { id: "claude-haiku-4-5", price: { input: 1, output: 5, cachedInput: 0.1 } },
  },
};

const OPENAI: ProviderPreset = {
  name: "openai",
  label: "OpenAI models",
  keyEnv: "OPENAI_API_KEY",
  id: "openai-api",
  baseUrl: "https://api.openai.com/v1",
  tiers: {
    top: { id: "gpt-6-sol", price: { input: 2, output: 10, cachedInput: 0.2 } },
    standard: { id: "gpt-6-sol", price: { input: 2, output: 10, cachedInput: 0.2 } },
    light: { id: "gpt-6-luna", price: { input: 0.1, output: 0.5, cachedInput: 0.01 } },
  },
};

// The free preview the project's own reviews run on; a preview can move,
// which the manual says (Model providers, Free models through OpenRouter).
const FREE = { id: "stealth/space-bunny-alpha", price: { input: 0, output: 0 } };
const OPENROUTER: ProviderPreset = {
  name: "openrouter",
  label: "OpenRouter's free model",
  keyEnv: "OPENROUTER_API_KEY",
  id: "router",
  baseUrl: "https://openrouter.ai/api/v1",
  tiers: { top: FREE, standard: FREE, light: FREE },
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

// The smallest .ocra/config.json that reviews with the preset on the direct
// runtime: models by tier and the one endpoint they are on.
export function configFor(preset: ProviderPreset): string {
  const { top, standard, light } = preset.tiers;
  const models = Object.fromEntries([top, standard, light].map((m) => [m.id, m.price]));
  const config = {
    $schema: SCHEMA_URL,
    runtime: "direct",
    models: {
      top: `${preset.id}/${top.id}`,
      standard: `${preset.id}/${standard.id}`,
      light: `${preset.id}/${light.id}`,
    },
    providers: {
      [preset.id]: {
        type: "openai-compatible",
        baseUrl: preset.baseUrl,
        apiKeyEnv: preset.keyEnv,
        models,
      },
    },
  };
  return `${JSON.stringify(config, null, 2)}\n`;
}
