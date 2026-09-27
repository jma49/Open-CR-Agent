import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type ModelChains,
  type ModelTier,
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
    extends: z.string().min(1).optional(),
  })
  .strict();

export type CliConfig = Omit<z.infer<typeof configSchema>, "models"> & {
  models: ModelChains;
  // Rules from a shared configuration named by extends.
  rules: RepoRule[];
};

export interface LoadOptions {
  repository: boolean;
  read?: (path: string) => Promise<string | undefined>;
  fetch?: typeof fetch;
  warn?: (message: string) => void;
}

const MODEL_ENV: Record<ModelTier, string> = {
  top: "OCRA_MODEL_TOP",
  standard: "OCRA_MODEL_STANDARD",
  light: "OCRA_MODEL_LIGHT",
};

export class ConfigError extends Error {}

// Without the repository's file, only defaults and environment variables
// apply: that file can name plugins, and plugins run code.
export async function loadConfig(
  root: string,
  env: Readonly<Record<string, string | undefined>>,
  options: LoadOptions = { repository: true },
): Promise<CliConfig> {
  const read = options.read ?? ((path: string) => readWorkingTreeFile(root, path));
  const { config: parsed, rules } = options.repository
    ? await readConfigFile(read, options)
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
  return { ...parsed, models, rules };
}

async function readWorkingTreeFile(root: string, path: string): Promise<string | undefined> {
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
): Promise<{ config: z.infer<typeof configSchema>; rules: RepoRule[] }> {
  const text = await read(CONFIG_PATH);
  if (text === undefined) return { config: configSchema.parse({}), rules: [] };
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (error) {
    throw new ConfigError(`${CONFIG_PATH} is not valid JSON: ${(error as Error).message}`);
  }
  const local = configSchema.safeParse(data);
  if (!local.success)
    throw new ConfigError(`${CONFIG_PATH} is invalid: ${z.prettifyError(local.error)}`);
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
