import {
  type AppliedSampling,
  type CustomProvider,
  MAX_AGENT_STEPS,
  OcraError,
  type Sampling,
} from "@open-cr-agent/core";
import type { ToolServer } from "./tool-server.js";

export const MCP_SERVER = "ocra";
export const REVIEW_AGENT = "ocra-reviewer";
export const HELPER_AGENT = "ocra-helper";
// The same agents without the configured temperature, for calls that send
// an effort (ADR-0025): OpenCode sets sampling per agent.
export const WITHOUT_SAMPLING = "-effort";
// Must not be empty: OpenCode falls back to its full coding prompt otherwise.
const REVIEW_AGENT_PROMPT =
  "You are a code review agent run by ocra. Follow the review instructions below.";
const HELPER_AGENT_PROMPT = "You answer exactly as the instructions below ask, with no tools.";
// The helper answers in one step and has no tools. It still needs two:
// OpenCode appends an assistant message on an agent's last allowed step, and
// Gemini rejects a request that ends with a model turn (#66).
export const HELPER_AGENT_STEPS = 2;

// Every OpenCode built-in tool of the pinned version; a test fails when an
// upgrade adds one, so a new write-capable tool can never be enabled silently.
export const OPENCODE_BUILTIN_TOOLS = [
  "invalid",
  "question",
  "bash",
  "read",
  "glob",
  "grep",
  "edit",
  "write",
  "task",
  "webfetch",
  "todowrite",
  "websearch",
  "skill",
  "apply_patch",
] as const;
export const DISABLED_BUILTINS = Object.fromEntries(OPENCODE_BUILTIN_TOOLS.map((t) => [t, false]));

// OpenCode 1.18.32 takes a temperature per agent and sends it when the
// model's catalog entry says the model accepts one; a model declared in
// configuration is marked so (providerConfig). It has no seed setting: the
// request it builds carries temperature, topP, topK and the output limit only.
export function openCodeSampling(sampling: Sampling = {}): AppliedSampling {
  return {
    ...(sampling.temperature === undefined ? {} : { temperature: sampling.temperature }),
    ...(sampling.seed === undefined ? {} : { notApplied: ["seed" as const] }),
  };
}

export function openCodeConfig(
  tools: Pick<ToolServer, "url" | "headers">,
  helperTools: Record<string, boolean>,
  custom: Readonly<Record<string, CustomProvider>> = {},
  sampling: Sampling = {},
) {
  const permission = { edit: "deny", bash: "deny", webfetch: "deny", skill: "deny" };
  const { temperature } = sampling;
  const agents = {
    [REVIEW_AGENT]: {
      mode: "primary",
      prompt: REVIEW_AGENT_PROMPT,
      steps: MAX_AGENT_STEPS,
      tools: DISABLED_BUILTINS,
      permission,
    },
    [HELPER_AGENT]: {
      mode: "primary",
      prompt: HELPER_AGENT_PROMPT,
      steps: HELPER_AGENT_STEPS,
      tools: helperTools,
      permission,
    },
  };
  return {
    share: "disabled",
    autoupdate: false,
    ...(Object.keys(custom).length > 0
      ? { provider: providerConfig(custom, temperature !== undefined) }
      : {}),
    mcp: {
      [MCP_SERVER]: {
        type: "remote",
        url: tools.url,
        headers: tools.headers,
        oauth: false,
        enabled: true,
      },
    },
    agent:
      temperature === undefined
        ? agents
        : Object.fromEntries(
            Object.entries(agents).flatMap(([name, agent]) => [
              [name, { ...agent, temperature }],
              [`${name}${WITHOUT_SAMPLING}`, agent],
            ]),
          ),
  };
}

// OpenCode's form of a provider declared in configuration. OpenCode bundles
// the OpenAI-compatible client, so nothing is installed to reach it
// (docs/spikes/0002). The key stays in the environment: OpenCode reads
// {env:NAME} itself, and the configuration, which OpenCode may log, never
// holds it. Prices are per million tokens, as OpenCode's catalog has them.
// OpenCode assumes a declared model takes no temperature and drops one;
// with a temperature configured, the models are marked as taking it.
function providerConfig(custom: Readonly<Record<string, CustomProvider>>, temperature: boolean) {
  for (const [id, provider] of Object.entries(custom)) checkProvider(id, provider);
  return Object.fromEntries(
    Object.entries(custom).map(([id, provider]) => [
      id,
      {
        npm: "@ai-sdk/openai-compatible",
        name: id,
        options: {
          baseURL: provider.baseUrl,
          ...(provider.apiKeyEnv ? { apiKey: `{env:${provider.apiKeyEnv}}` } : {}),
        },
        models: Object.fromEntries(
          Object.entries(provider.models).map(([model, price]) => [
            model,
            {
              name: model,
              ...(temperature ? { temperature: true } : {}),
              cost: {
                input: price.input,
                output: price.output,
                ...(price.cachedInput === undefined ? {} : { cache_read: price.cachedInput }),
              },
            },
          ]),
        ),
      },
    ]),
  );
}

// Checked here once, whatever declared the provider: a configuration file,
// ocra Cloud or another caller of this package.
function checkProvider(id: string, provider: CustomProvider): void {
  const fields: [string, string][] = [
    ["id", id],
    ["baseUrl", provider.baseUrl],
    ...Object.keys(provider.models).map((model): [string, string] => ["model", model]),
  ];
  for (const [field, value] of fields) {
    if (/[{}]/.test(value)) {
      throw new OcraError("CONFIG_INVALID", `Provider "${id}": ${field} must not contain { or }`);
    }
  }
  if (provider.apiKeyEnv !== undefined && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(provider.apiKeyEnv)) {
    throw new OcraError(
      "CONFIG_INVALID",
      `Provider "${id}": apiKeyEnv must be an environment variable name`,
    );
  }
}
