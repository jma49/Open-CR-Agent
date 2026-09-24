import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ModelTier } from "@open-cr-agent/core";
import { z } from "zod";

export const CONFIG_PATH = ".ocra/config.json";

const configSchema = z
  .object({
    models: z
      .object({ top: z.string().min(1), standard: z.string().min(1), light: z.string().min(1) })
      .partial()
      .strict()
      .default({}),
    concurrency: z.number().int().min(1).max(32).optional(),
    taskTimeoutMinutes: z.number().positive().optional(),
    runTimeoutMinutes: z.number().positive().optional(),
    include: z.array(z.string().min(1)).default([]),
    exclude: z.array(z.string().min(1)).default([]),
    runtime: z.string().min(1).default("opencode"),
    plugins: z.array(z.string().min(1)).default([]),
    pluginSettings: z.record(z.string(), z.unknown()).default({}),
  })
  .strict();

export type CliConfig = z.infer<typeof configSchema>;

const MODEL_ENV: Record<ModelTier, string> = {
  top: "OCRA_MODEL_TOP",
  standard: "OCRA_MODEL_STANDARD",
  light: "OCRA_MODEL_LIGHT",
};

export class ConfigError extends Error {}

export async function loadConfig(
  root: string,
  env: Readonly<Record<string, string | undefined>>,
): Promise<CliConfig> {
  const config = await readConfigFile(root);
  for (const [tier, name] of Object.entries(MODEL_ENV) as [ModelTier, string][]) {
    const value = env[name]?.trim();
    if (value) config.models[tier] = value;
  }
  return config;
}

async function readConfigFile(root: string): Promise<CliConfig> {
  let text: string;
  try {
    text = await readFile(join(root, CONFIG_PATH), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return configSchema.parse({});
    throw error;
  }
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
