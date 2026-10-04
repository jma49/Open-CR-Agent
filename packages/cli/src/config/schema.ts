import { type AgentRole, EFFORT_LEVELS, type RiskTier } from "@open-cr-agent/core";
import { AGENT_ROLES, MAX_TIMER_MS, RISK_TIERS } from "@open-cr-agent/core/internal";
import { z } from "zod";

// What .ocra/config.json may say. Every layer of settings (settings.ts) is
// checked against it.

// How much a model reasons before answering (ADR-0025); unset leaves the
// provider's default.
export const effort = z.enum(EFFORT_LEVELS);
// The longest timeout a timer keeps, about 24.8 days; a longer one would fire at once.
const timeoutMinutes = z
  .number()
  .positive()
  .max(Math.floor(MAX_TIMER_MS / 60_000))
  .optional();

const modelChain = z
  .union([z.string().min(1), z.array(z.string().min(1)).min(1)])
  .transform((value) => (typeof value === "string" ? [value] : value));

// Where review code is sent: over https, or plain http only to this machine.
// OpenCode replaces {env:NAME} and {file:path} anywhere in its configuration,
// so an address with braces could carry a variable or a file (the checkout's
// .git/config holds its token) to the endpoint.
const endpoint = z
  .url()
  .refine((value) => {
    const url = new URL(value);
    if (url.protocol === "https:") return true;
    const host = url.hostname.replace(/^\[|\]$/g, "");
    return (
      url.protocol === "http:" &&
      (host === "localhost" || host === "::1" || /^127\.\d+\.\d+\.\d+$/.test(host))
    );
  }, "must be an https URL, or http on this machine (localhost, 127.0.0.1, ::1)")
  .refine((value) => !/[{}]/.test(value), "must not contain { or }");

// The platforms' and clouds' credentials never go to a model endpoint; the
// same prefixes are never passed to the runtime by prefix (server-env.ts).
const PLATFORM_TOKENS = /^(GITHUB_|GH_|GITLAB_|CI_|ACTIONS_|RUNNER_|AWS_|AZURE_|NPM_|SSH_|OCRA_)/;
const price = z.number().min(0).max(10_000);

const providerSchema = z
  .object({
    type: z.literal("openai-compatible"),
    baseUrl: endpoint,
    apiKeyEnv: z
      .string()
      .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "must be an environment variable name")
      .refine((name) => !PLATFORM_TOKENS.test(name), "must not name a platform or cloud credential")
      .optional(),
    // Prices in US dollars per million tokens; 0 means unpriced.
    models: z
      .record(
        z.string().regex(/^[\w./:@-]{1,200}$/),
        z.object({ input: price, output: price, cachedInput: price.optional() }).strict(),
      )
      .refine((models) => Object.keys(models).length > 0, "must list at least one model"),
    // How the endpoint takes a reasoning effort: "openai" sends
    // reasoning_effort (the default), "openrouter" sends reasoning.effort.
    effort: z.enum(["openai", "openrouter"]).optional(),
  })
  .strict();

// The runtimes ocra ships; a plugin may register another name, so the
// schema lists these for editors and still accepts any other string.
const BUILTIN_RUNTIMES = ["opencode", "direct"] as const;
export const DEFAULT_RUNTIME = "opencode";

export const configSchema = z
  .object({
    $schema: z.string().optional(),
    models: z
      .object({ top: modelChain, standard: modelChain, light: modelChain })
      .partial()
      .strict()
      .default({}),
    effort: z
      .object({ top: effort, standard: effort, light: effort })
      .partial()
      .strict()
      .default({}),
    concurrency: z.number().int().min(1).max(32).optional(),
    taskTimeoutMinutes: timeoutMinutes,
    runTimeoutMinutes: timeoutMinutes,
    verify: z.boolean().optional(),
    judge: z.boolean().optional(),
    maxCostUsd: z.number().positive().optional(),
    maxTasks: z.number().int().min(1).max(1_000).optional(),
    // Unset: each provider's default. A seed makes sampling repeatable only
    // where the provider supports it.
    sampling: z
      .object({
        temperature: z.number().min(0).max(2),
        seed: z
          .number()
          .int()
          .min(0)
          .max(2 ** 31 - 1),
      })
      .partial()
      .strict()
      .optional(),
    github: z
      .object({ requestChanges: z.boolean(), botLogin: z.string().min(1) })
      .partial()
      .strict()
      .default({}),
    include: z.array(z.string().min(1)).default([]),
    exclude: z.array(z.string().min(1)).default([]),
    // Unset means "opencode"; loadConfig fills it in and records whether the
    // file chose, so account defaults (ADR-0025) apply only where it did not.
    runtime: z.enum(BUILTIN_RUNTIMES).or(z.string().min(1)).optional(),
    plugins: z.array(z.string().min(1)).default([]),
    reviewers: z
      .record(
        z.string(),
        z
          .object({
            enabled: z.boolean(),
            minTier: z.enum(RISK_TIERS as [RiskTier, ...RiskTier[]]),
            // The reviewer's own chain, for its review tasks and plan call.
            models: modelChain,
            effort,
          })
          .partial()
          .strict(),
      )
      .default({}),
    roles: z
      .partialRecord(
        z.enum(AGENT_ROLES as [AgentRole, ...AgentRole[]]),
        z.object({ models: modelChain, effort }).partial().strict(),
      )
      .default({}),
    pluginSettings: z.record(z.string(), z.unknown()).default({}),
    providers: z.record(z.string().regex(/^[a-z][a-z0-9-]{0,39}$/), providerSchema).default({}),
    extends: z.string().min(1).optional(),
  })
  .strict();

export const CONFIG_SCHEMA_ID = "https://ocra.majincheng.com/schema/config.v1.json";

// JSON Schema (draft 2020-12) of .ocra/config.json, for editors: what a
// file may say, so defaults are optional and model chains take either form.
export function configJsonSchema(): Record<string, unknown> {
  const generated = z.toJSONSchema(configSchema, { target: "draft-2020-12", io: "input" });
  const { $schema, ...rest } = generated;
  return {
    $schema,
    $id: CONFIG_SCHEMA_ID,
    title: "ocra configuration",
    description:
      "The .ocra/config.json file of a repository, or a file passed with --config. Unknown keys are rejected.",
    ...rest,
  };
}
