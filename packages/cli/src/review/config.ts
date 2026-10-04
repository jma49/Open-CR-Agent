import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type CustomProvider,
  type ModelChains,
  type ModelTier,
  OcraError,
  type RepoRule,
  RISK_TIERS,
  type RiskTier,
} from "@open-cr-agent/core";
import { z } from "zod";
import { fetchRemoteConfig, mergeConfig, type RemoteConfig } from "./remote-config.js";

export const CONFIG_PATH = ".ocra/config.json";

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
  })
  .strict();

const configSchema = z
  .object({
    models: z
      .object({ top: modelChain, standard: modelChain, light: modelChain })
      .partial()
      .strict()
      .default({}),
    concurrency: z.number().int().min(1).max(32).optional(),
    taskTimeoutMinutes: z.number().positive().optional(),
    runTimeoutMinutes: z.number().positive().optional(),
    verify: z.boolean().optional(),
    judge: z.boolean().optional(),
    maxCostUsd: z.number().positive().optional(),
    maxTasks: z.number().int().min(1).max(1_000).optional(),
    github: z
      .object({ requestChanges: z.boolean(), botLogin: z.string().min(1) })
      .partial()
      .strict()
      .default({}),
    include: z.array(z.string().min(1)).default([]),
    exclude: z.array(z.string().min(1)).default([]),
    runtime: z.string().min(1).default("opencode"),
    plugins: z.array(z.string().min(1)).default([]),
    reviewers: z
      .record(
        z.string(),
        z
          .object({
            enabled: z.boolean(),
            minTier: z.enum(RISK_TIERS as [RiskTier, ...RiskTier[]]),
          })
          .partial()
          .strict(),
      )
      .default({}),
    pluginSettings: z.record(z.string(), z.unknown()).default({}),
    providers: z.record(z.string().regex(/^[a-z][a-z0-9-]{0,39}$/), providerSchema).default({}),
    extends: z.string().min(1).optional(),
  })
  .strict();

export type CliConfig = Omit<z.infer<typeof configSchema>, "models" | "providers"> & {
  models: ModelChains;
  providers: Record<string, CustomProvider>;
  // Rules from a shared configuration named by extends.
  rules: RepoRule[];
};

export interface LoadOptions {
  repository: boolean;
  read?: (path: string) => Promise<string | undefined>;
  // A file of the user's own (--config), read instead of the repository's;
  // it is theirs to trust, so it applies with --no-repo-config too.
  file?: string;
  fetch?: typeof fetch;
  warn?: (message: string) => void;
}

const MODEL_ENV: Record<ModelTier, string> = {
  top: "OCRA_MODEL_TOP",
  standard: "OCRA_MODEL_STANDARD",
  light: "OCRA_MODEL_LIGHT",
};

export class ConfigError extends OcraError {
  constructor(message: string, options?: { cause?: unknown }) {
    super("CONFIG_INVALID", message, options);
    this.name = "ConfigError";
  }
}

// Without the repository's file, only defaults and environment variables
// apply: that file can name plugins, and plugins run code.
export async function loadConfig(
  root: string,
  env: Readonly<Record<string, string | undefined>>,
  options: LoadOptions = { repository: true },
): Promise<CliConfig> {
  const read = options.read ?? ((path: string) => readConfigFromDisk(root, path));
  const { config: parsed, rules } = options.file
    ? await readConfigFile(ownFile(options.file), options, options.file)
    : options.repository
      ? await readConfigFile(read, options, CONFIG_PATH)
      : { config: configSchema.parse({}), rules: [] };
  const models: { -readonly [Tier in ModelTier]?: readonly string[] } = {};
  for (const [tier, chain] of Object.entries(parsed.models) as [
    ModelTier,
    string[] | undefined,
  ][]) {
    if (chain) models[tier] = chain;
  }
  for (const [tier, name] of Object.entries(MODEL_ENV) as [ModelTier, string][]) {
    const chain = (env[name] ?? "")
      .split(",")
      .map((m) => m.trim())
      .filter((m) => m !== "");
    if (chain.length > 0) models[tier] = chain;
  }
  for (const model of unpriced(parsed.providers, models)) {
    options.warn?.(
      `${model} has a price of 0: reported cost and --max-cost-usd do not count its tokens`,
    );
  }
  return { ...parsed, models, providers: toProviders(parsed.providers), rules };
}

function toProviders(
  declared: z.infer<typeof configSchema>["providers"],
): Record<string, CustomProvider> {
  return Object.fromEntries(
    Object.entries(declared).map(([id, p]) => [
      id,
      {
        baseUrl: p.baseUrl,
        ...(p.apiKeyEnv ? { apiKeyEnv: p.apiKeyEnv } : {}),
        models: Object.fromEntries(
          Object.entries(p.models).map(([model, price]) => [
            model,
            {
              input: price.input,
              output: price.output,
              ...(price.cachedInput === undefined ? {} : { cachedInput: price.cachedInput }),
            },
          ]),
        ),
      },
    ]),
  );
}

// Models of declared providers, named in a chain, priced at 0 per token.
function unpriced(
  providers: z.infer<typeof configSchema>["providers"],
  models: ModelChains,
): string[] {
  const named = new Set(Object.values(models).flat());
  return [...named].filter((model) => {
    const slash = model.indexOf("/");
    const price = providers[model.slice(0, slash)]?.models[model.slice(slash + 1)];
    return price !== undefined && price.input === 0 && price.output === 0;
  });
}

// The user's own checkout, read like any local file (links followed): unlike
// the review's reads, which never follow links (vcs-local), this is trusted
// configuration, and --no-repo-config skips it for code that is not.
function ownFile(file: string): () => Promise<string> {
  return async () => {
    try {
      return await readFile(file, "utf8");
    } catch (error) {
      throw new ConfigError(`cannot read ${file}: ${(error as Error).message}`, { cause: error });
    }
  };
}

async function readConfigFromDisk(root: string, path: string): Promise<string | undefined> {
  try {
    return await readFile(join(root, path), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function readConfigFile(
  read: (path: string) => Promise<string | undefined>,
  options: LoadOptions,
  label: string,
): Promise<{ config: z.infer<typeof configSchema>; rules: RepoRule[] }> {
  const text = await read(CONFIG_PATH);
  if (text === undefined) return { config: configSchema.parse({}), rules: [] };
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (error) {
    throw new ConfigError(`${label} is not valid JSON: ${(error as Error).message}`, {
      cause: error,
    });
  }
  const local = configSchema.safeParse(data);
  if (!local.success) throw new ConfigError(`${label} is invalid: ${z.prettifyError(local.error)}`);
  if (!local.data.extends) return { config: local.data, rules: [] };

  // A shared configuration that cannot be loaded costs its defaults, not the
  // review: the repository's own settings still apply.
  let remote: RemoteConfig;
  try {
    remote = await fetchRemoteConfig(local.data.extends, options.fetch);
  } catch (error) {
    // Its limits are lost with it; say so rather than run silently unbounded.
    const limits =
      local.data.maxCostUsd === undefined
        ? "; none of its settings apply, including any spend or task limit"
        : "; none of its settings apply";
    options.warn?.(
      `could not load extends ${local.data.extends}: ${(error as Error).message}${limits}`,
    );
    return { config: local.data, rules: [] };
  }
  const merged = configSchema.safeParse(mergeConfig(remote, data as Record<string, unknown>));
  if (!merged.success) {
    options.warn?.(
      `ignoring extends ${local.data.extends}: its settings are invalid (${z.prettifyError(merged.error)})`,
    );
    return { config: local.data, rules: [] };
  }
  return { config: merged.data, rules: remote.rules ?? [] };
}
