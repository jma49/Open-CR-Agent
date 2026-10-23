import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import { redact } from "@open-cr-agent/cloud-contract";
import type { RunProvenance } from "@open-cr-agent/core";
import { z } from "zod";
import { type OcraBuild, ocraBuildSchema } from "./ocra-build.js";

// What a review ran on beyond what ocra's report records (provenance): the
// build, runtime and OpenCode install of the ocra-eval invocation that ran
// it, when, and OpenCode's catalog entries for its models. Each PR's result
// keeps its own, so a run resumed by a later invocation on another commit or
// catalog shows it.

export const opencodeSchema = z.strictObject({
  // The opencode-ai package the CLI's runtime resolves; absent when none is installed.
  version: z.string().exactOptional(),
  // OCRA_OPENCODE_BIN, which runs another binary than the package's.
  bin: z.string().exactOptional(),
});
export type OpencodeInstall = z.output<typeof opencodeSchema>;

// By model: the fields of its catalog entry that change what a review costs
// or sends (CATALOG_FIELDS).
export const catalogSchema = z.record(z.string(), z.record(z.string(), z.unknown()));
export type CatalogEntries = z.output<typeof catalogSchema>;

export const ranOnSchema = z.strictObject({
  at: z.string(),
  ocra: ocraBuildSchema,
  // Absent when a shared configuration (extends) chooses it.
  runtime: z.string().exactOptional(),
  opencode: opencodeSchema.exactOptional(),
  // The sha256 of the --config file, copied to config/<sha256>.json in the run.
  config: z.string().exactOptional(),
  catalog: catalogSchema.exactOptional(),
});
export type RanOn = z.output<typeof ranOnSchema>;

interface ConfigSnapshot {
  file: string;
  sha256: string;
  runtime?: string;
}

export interface Setup {
  ocra: OcraBuild;
  runtime?: string;
  opencode?: OpencodeInstall;
  config?: ConfigSnapshot;
}

// ocra's own default (cli config/schema.ts DEFAULT_RUNTIME), which the CLI
// does not export: copied, not imported.
const DEFAULT_RUNTIME = "opencode";

export function configSnapshotPath(sha256: string): string {
  return join("config", `${sha256}.json`);
}

// What one invocation of ocra-eval runs every review on. The --config file
// is copied into the run, since it may be gone when the run is read again.
export async function runSetup(
  ocra: OcraBuild,
  runDir: string,
  configFile: string | undefined,
  env: NodeJS.ProcessEnv,
  cliRoot: string,
): Promise<Setup> {
  const config = configFile === undefined ? undefined : await snapshotConfig(configFile, runDir);
  // With --no-repo-config only that file and the environment configure the
  // review, and no environment variable names a runtime.
  const runtime = config ? config.runtime : DEFAULT_RUNTIME;
  const opencode =
    runtime === undefined || runtime === DEFAULT_RUNTIME
      ? opencodeInstall(cliRoot, env)
      : undefined;
  return {
    ocra,
    ...(runtime === undefined ? {} : { runtime }),
    ...(opencode ? { opencode } : {}),
    ...(config ? { config } : {}),
  };
}

// A configuration names the variables that hold keys, never keys, but the
// file is the user's: anything that looks secret is redacted from the copy,
// which is kept under the hash of the original, so a run resumed with
// another file keeps both.
async function snapshotConfig(file: string, runDir: string): Promise<ConfigSnapshot> {
  const bytes = await readFile(file);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const text = bytes.toString("utf8");
  await mkdir(join(runDir, "config"), { recursive: true });
  await writeFile(join(runDir, configSnapshotPath(sha256)), redact(text).text, { mode: 0o600 });
  const runtime = configuredRuntime(text);
  return { file, sha256, ...(runtime === undefined ? {} : { runtime }) };
}

function configuredRuntime(text: string): string | undefined {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof data !== "object" || data === null) return undefined;
  const { runtime, extends: shared } = data as { runtime?: unknown; extends?: unknown };
  if (typeof runtime === "string") return runtime;
  return shared === undefined ? DEFAULT_RUNTIME : undefined;
}

// The opencode-ai package next to the CLI's runtime-opencode, which is
// where the runtime takes its binary from (runtime-opencode binary.ts).
export function opencodeInstall(
  cliRoot: string,
  env: NodeJS.ProcessEnv,
): OpencodeInstall | undefined {
  const bin = env.OCRA_OPENCODE_BIN;
  const install: OpencodeInstall = bin ? { bin } : {};
  try {
    const runtime = createRequire(join(cliRoot, "package.json")).resolve(
      "@open-cr-agent/runtime-opencode/package.json",
    );
    const opencode = createRequire(runtime).resolve("opencode-ai/package.json");
    const { version } = JSON.parse(readFileSync(opencode, "utf8")) as { version?: unknown };
    if (typeof version === "string") install.version = version;
  } catch {
    // Not installed: the review fails to start, and says why.
  }
  return Object.keys(install).length > 0 ? install : undefined;
}

// OpenCode prices calls from its catalog (models.opencode.ai), kept in
// models.json in its cache directory and refreshed while it runs. ocra
// isolates OpenCode's configuration, data and state but not its cache, and
// passes it HOME but not XDG_CACHE_HOME (runtime-opencode server-env.ts), so
// the file is under HOME. Read when a review ends, it holds the entries
// that review most likely used; ocra's report does not say which it did.
export function catalogFile(env: NodeJS.ProcessEnv): string {
  return join(env.HOME || homedir(), ".cache", "opencode", "models.json");
}

const CATALOG_FIELDS = [
  "cost",
  "limit",
  "temperature",
  "reasoning",
  "reasoning_options",
  "tool_call",
  "last_updated",
] as const;

// About ten times the catalog's size in 2026-10.
const MAX_CATALOG_BYTES = 64 * 1024 * 1024;

// The entries of the models given, those the catalog has; undefined when it
// cannot be read.
export async function catalogEntries(
  file: string,
  models: readonly string[],
): Promise<CatalogEntries | undefined> {
  let catalog: unknown;
  try {
    if ((await stat(file)).size > MAX_CATALOG_BYTES) return undefined;
    catalog = JSON.parse(await readFile(file, "utf8"));
  } catch {
    return undefined;
  }
  const entries: CatalogEntries = {};
  for (const model of [...new Set(models)].sort()) {
    const entry = catalogEntry(catalog, model);
    if (entry) entries[model] = entry;
  }
  return entries;
}

// The catalog is { provider: { models: { model: entry } } }; ocra names a
// model provider/model, and the model may itself contain a slash.
function catalogEntry(catalog: unknown, model: string): Record<string, unknown> | undefined {
  const slash = model.indexOf("/");
  if (slash < 0) return undefined;
  const provider = field(catalog, model.slice(0, slash));
  const entry = field(field(provider, "models"), model.slice(slash + 1));
  if (typeof entry !== "object" || entry === null) return undefined;
  const picked: Record<string, unknown> = {};
  for (const name of CATALOG_FIELDS) {
    const value = field(entry, name);
    if (value !== undefined) picked[name] = value;
  }
  return picked;
}

function field(value: unknown, name: string): unknown {
  return typeof value === "object" && value !== null && Object.hasOwn(value, name)
    ? (value as Record<string, unknown>)[name]
    : undefined;
}

// Every model of every agent's chain, as the review's report names them.
export function modelsOf(provenance: RunProvenance | undefined): string[] {
  return Object.values(provenance?.agents ?? {}).flatMap((agent) => agent.models ?? []);
}

// What each review of this invocation ran on, read when it ends.
export function ranOnFor(
  setup: Setup,
  catalog: string,
  now: () => Date = () => new Date(),
): (models: readonly string[]) => Promise<RanOn> {
  return async (models) => {
    const entries = setup.opencode ? await catalogEntries(catalog, models) : undefined;
    return {
      at: now().toISOString(),
      ocra: setup.ocra,
      ...(setup.runtime === undefined ? {} : { runtime: setup.runtime }),
      ...(setup.opencode ? { opencode: setup.opencode } : {}),
      ...(setup.config ? { config: setup.config.sha256 } : {}),
      ...(entries ? { catalog: entries } : {}),
    };
  };
}
