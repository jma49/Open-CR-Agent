import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type CustomProvider,
  EFFORT_LEVELS,
  type Effort,
  MODEL_TIERS,
  type ModelChains,
  type ModelTier,
  OcraError,
  type ReviewerOverrides,
  type RoleSettings,
  type SourcedRule,
  type TierEfforts,
} from "@open-cr-agent/core";
import { z } from "zod";
import { fetchRemoteConfig, type RemoteConfig } from "./remote.js";
import { type configSchema, DEFAULT_RUNTIME, effort } from "./schema.js";
import { layerSchema, resolveSettings, type SettingsLayer } from "./settings.js";

export const CONFIG_PATH = ".ocra/config.json";

export type CliConfig = Omit<
  z.infer<typeof configSchema>,
  "models" | "effort" | "providers" | "runtime"
> & {
  runtime: string;
  // Whether the configuration chose the runtime (else it is the default).
  runtimeSet: boolean;
  models: ModelChains;
  // The file's, with OCRA_EFFORT_<TIER> on top.
  effort: TierEfforts;
  providers: Record<string, CustomProvider>;
  // Rules from a shared configuration named by extends, then the account's.
  rules: SourcedRule[];
  // The ocra Cloud account settings layered under this configuration
  // (ADR-0027), by version; absent when none were.
  accountSettings?: { version: string | null };
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

// OCRA_MODEL_TOP, OCRA_EFFORT_STANDARD and so on.
const tierEnv = (prefix: string) =>
  Object.fromEntries(
    MODEL_TIERS.map((tier) => [tier, `${prefix}_${tier.toUpperCase()}`]),
  ) as Record<ModelTier, string>;
const MODEL_ENV = tierEnv("OCRA_MODEL");
const EFFORT_ENV = tierEnv("OCRA_EFFORT");

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
  const { settings, sources } = resolveSettings(await configLayers(root, env, options));
  for (const model of unpriced(settings.providers, [
    ...Object.values(settings.models),
    ...Object.values(agentChains(settings)),
  ])) {
    options.warn?.(
      `${model} has a price of 0: reported cost and --max-cost-usd do not count its tokens`,
    );
  }
  return {
    ...settings,
    runtime: settings.runtime ?? DEFAULT_RUNTIME,
    runtimeSet: sources.runtime !== undefined,
    models: defined(settings.models),
    effort: defined(settings.effort),
    providers: toProviders(settings.providers),
  };
}

function defined<T extends object>(map: T): { [K in keyof T]?: Exclude<T[K], undefined> } {
  return Object.fromEntries(Object.entries(map).filter(([, value]) => value !== undefined)) as {
    [K in keyof T]?: Exclude<T[K], undefined>;
  };
}

// The configuration's layers, earliest first: a shared configuration it
// extends, the file, and OCRA_MODEL_<TIER> and OCRA_EFFORT_<TIER> on top.
async function configLayers(
  root: string,
  env: Readonly<Record<string, string | undefined>>,
  options: LoadOptions,
): Promise<SettingsLayer[]> {
  const read = options.read ?? ((path: string) => readConfigFromDisk(root, path));
  const files = options.file
    ? await fileLayers(ownFile(options.file), options, options.file)
    : options.repository
      ? await fileLayers(read, options, CONFIG_PATH)
      : [];
  return [...files, envLayer(env)];
}

function envLayer(env: Readonly<Record<string, string | undefined>>): SettingsLayer {
  const models: Partial<Record<ModelTier, string[]>> = {};
  const efforts: Partial<Record<ModelTier, Effort>> = {};
  for (const tier of MODEL_TIERS) {
    const chain = (env[MODEL_ENV[tier]] ?? "")
      .split(",")
      .map((m) => m.trim())
      .filter((m) => m !== "");
    if (chain.length > 0) models[tier] = chain;
  }
  for (const tier of MODEL_TIERS) {
    const name = EFFORT_ENV[tier];
    const value = env[name]?.trim();
    if (!value) continue;
    const level = effort.safeParse(value);
    if (!level.success) {
      throw new ConfigError(`${name} must be one of ${EFFORT_LEVELS.join(", ")}`);
    }
    efforts[tier] = level.data;
  }
  return { source: "env", settings: { models, effort: efforts } };
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
        ...(p.effort ? { effort: p.effort } : {}),
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

// The reviewers' and roles' own chains, by agent id (ADR-0025); a disabled
// reviewer's is left out, since it makes no call.
export function agentChains(config: {
  reviewers: ReviewerOverrides;
  roles: RoleSettings;
}): Record<string, readonly string[]> {
  const chains: Record<string, readonly string[]> = {};
  for (const [id, setting] of Object.entries(config.reviewers)) {
    if (setting.models && setting.enabled !== false) chains[id] = setting.models;
  }
  for (const [role, setting] of Object.entries(config.roles)) {
    if (setting?.models) chains[role] = setting.models;
  }
  return chains;
}

// Models of declared providers, named in a chain, priced at 0 per token.
function unpriced(
  providers: z.infer<typeof configSchema>["providers"],
  chains: readonly (readonly string[] | undefined)[],
): string[] {
  const named = new Set(chains.flatMap((chain) => chain ?? []));
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

// The file, and the shared configuration it extends under it.
async function fileLayers(
  read: (path: string) => Promise<string | undefined>,
  options: LoadOptions,
  label: string,
): Promise<SettingsLayer[]> {
  const text = await read(CONFIG_PATH);
  if (text === undefined) return [];
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (error) {
    throw new ConfigError(`${label} is not valid JSON: ${(error as Error).message}`, {
      cause: error,
    });
  }
  const local = layerSchema.safeParse(data);
  if (!local.success) throw new ConfigError(`${label} is invalid: ${z.prettifyError(local.error)}`);
  const file: SettingsLayer = { source: "file", settings: local.data };
  const shared = local.data.extends;
  if (!shared) return [file];

  // A shared configuration that cannot be loaded costs its defaults, not the
  // review: the repository's own settings still apply.
  let remote: RemoteConfig;
  try {
    remote = await fetchRemoteConfig(shared, options.fetch);
  } catch (error) {
    // Its limits are lost with it; say so rather than run silently unbounded.
    const limits =
      local.data.maxCostUsd === undefined
        ? "; none of its settings apply, including any spend or task limit"
        : "; none of its settings apply";
    options.warn?.(`could not load extends ${shared}: ${(error as Error).message}${limits}`);
    return [file];
  }
  const { rules = [], ...rest } = remote;
  const settings = layerSchema.safeParse(rest);
  if (!settings.success) {
    options.warn?.(
      `ignoring extends ${shared}: its settings are invalid (${z.prettifyError(settings.error)})`,
    );
    return [file];
  }
  const sourced = rules.map((rule): SourcedRule => ({ ...rule, source: "shared" }));
  return [{ source: "shared", settings: { ...settings.data, rules: sourced } }, file];
}
