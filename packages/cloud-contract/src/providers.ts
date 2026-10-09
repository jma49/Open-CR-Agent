import { z } from "zod";

// The model providers ocra Cloud's gateway forwards to (ADR-0024). A model
// named ocra-<provider>/<model> goes through the gateway with the key the
// account stored for <provider>.

/** The providers the gateway knows today; GET /api/providers lists them with their paths. */
export const PROVIDER_IDS = [
  "openai",
  "anthropic",
  "openrouter",
  "gemini",
  "deepseek",
  "mistral",
  "groq",
  "xai",
  "together",
  "fireworks",
  "cerebras",
  "moonshot",
  "moonshot-cn",
  "kimi-coding",
  "zai",
  "zhipu",
  "qwen",
  "qwen-cn",
  "minimax",
  "minimax-cn",
  "siliconflow",
  "siliconflow-cn",
  "volcengine",
  "qianfan",
  "hunyuan",
  "stepfun",
  "baichuan",
  "longcat",
  "huggingface",
  "cohere",
  "vercel",
  "deepinfra",
  "perplexity",
  "venice",
  "novita",
  "nebius",
  "sambanova",
  "inference-net",
  "chutes",
  "upstage",
  "ai21",
  "ionos",
  "scaleway",
  "featherless",
  "opencode-zen",
] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

// What a provider id and a model id may look like. A client checks names
// against these, not against PROVIDER_IDS, so a provider the gateway adds
// later works without a new client.
export const PROVIDER_ID = /^[a-z][a-z0-9-]{0,39}$/;
export const MODEL_ID = /^[\w./:@-]{1,200}$/;
/**
 * A path the gateway forwards, as GET /api/providers lists it: plain
 * segments, none of them `.` or `..`, which a URL would resolve out of the
 * provider's prefix to another endpoint of the server.
 */
export const GATEWAY_PATH = /^(?:\/(?!\.\.?(?:\/|$))[\w.-]+)+$/;

export const CLOUD_PREFIX = "ocra-";

/** Whether `model` is ocra-<provider>/<model> with a provider id and model id ocra Cloud may use. */
export function isCloudModel(model: string): boolean {
  const slash = model.indexOf("/");
  return (
    slash > 0 &&
    model.startsWith(CLOUD_PREFIX) &&
    PROVIDER_ID.test(model.slice(CLOUD_PREFIX.length, slash)) &&
    MODEL_ID.test(model.slice(slash + 1))
  );
}

/** How a provider takes a reasoning effort; unlisted, OpenAI's `reasoning_effort`. */
export const EFFORT_STYLES = ["openai", "openrouter"] as const;
export type EffortStyle = (typeof EFFORT_STYLES)[number];

// GET /api/providers. An entry that does not fit is left out on its own;
// paths are checked one by one where they are used, and an effort style a
// client does not know is refused there.
export const providersAnswerSchema = z.object({ providers: z.array(z.unknown()) });
export const providerEntrySchema = z.object({
  name: z.string(),
  paths: z.array(z.unknown()),
  effort: z.unknown().optional(),
});
export type ProviderEntry = z.infer<typeof providerEntrySchema>;
