import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { type ModelChains, type ModelTier, RISK_TIERS, type RiskTier } from "@open-cr-agent/core";
import { z } from "zod";

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
  })
  .strict();

export type CliConfig = Omit<z.infer<typeof configSchema>, "models"> & { models: ModelChains };

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
  options: { repository: boolean; read?: (path: string) => Promise<string | undefined> } = {
    repository: true,
  },
): Promise<CliConfig> {
  const read = options.read ?? ((path: string) => readWorkingTreeFile(root, path));
  const parsed = options.repository ? await readConfigFile(read) : configSchema.parse({});
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
  return { ...parsed, models };
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
): Promise<z.infer<typeof configSchema>> {
  const text = await read(CONFIG_PATH);
  if (text === undefined) return configSchema.parse({});
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (error) {
    throw new ConfigError(`${CONFIG_PATH} is not valid JSON: ${(error as Error).message}`);
  }
  const parsed = configSchema.safeParse(data);
  if (!parsed.success)
    throw new ConfigError(`${CONFIG_PATH} is invalid: ${z.prettifyError(parsed.error)}`);
  return parsed.data;
}
