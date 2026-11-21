import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SINGLE_AGENT_REVIEWER } from "./single-agent.js";

const SETUPS = ["single-agent"] as const;
export type SetupName = (typeof SETUPS)[number];

export function setupName(value: string | undefined): SetupName | undefined {
  if (value === undefined) return undefined;
  if ((SETUPS as readonly string[]).includes(value)) return value as SetupName;
  throw new Error(`--setup must be one of: ${SETUPS.join(", ")}`);
}

// The user's configuration (models, providers, limits) with the setup on
// top: the single agent is the only reviewer, and nothing checks or merges
// its findings after it. A configuration that names plugins is refused: the
// copy lives elsewhere, so its relative paths would resolve elsewhere too.
export function singleAgentConfig(user: unknown, pluginFile: string): Record<string, unknown> {
  if (user !== undefined && (typeof user !== "object" || user === null || Array.isArray(user))) {
    throw new Error("--config must hold a JSON object");
  }
  const base = (user ?? {}) as Record<string, unknown>;
  if (base.plugins !== undefined) {
    throw new Error("--setup cannot be combined with a configuration that names plugins");
  }
  return { ...base, plugins: [pluginFile], verify: false, judge: false };
}

// Writes the setup's configuration into the run directory and returns what
// ocra review is given instead of the user's --config.
export async function prepareSetup(
  setup: SetupName,
  userConfigFile: string | undefined,
  runDir: string,
): Promise<{ configFile: string; reviewArgs: string[] }> {
  const user =
    userConfigFile === undefined
      ? undefined
      : (JSON.parse(await readFile(userConfigFile, "utf8")) as unknown);
  // The built plugin, from src/setups (tests) as from dist/setups: the CLI
  // imports it with plain Node.
  const pluginFile = fileURLToPath(new URL("../../dist/setups/single-agent.js", import.meta.url));
  const configFile = join(runDir, `setup-${setup}.config.json`);
  await writeFile(configFile, `${JSON.stringify(singleAgentConfig(user, pluginFile), null, 2)}\n`);
  return { configFile, reviewArgs: ["--reviewers", SINGLE_AGENT_REVIEWER] };
}
