import type { Env } from "@open-cr-agent/core";

export interface IsolatedDirs {
  config: string;
  data: string;
  state: string;
}

// OpenCode otherwise reads the user's global config, installed skills and the
// repository's AGENTS.md into every prompt, which leaks local details to the
// model provider, duplicates our guidelines and costs tokens.
const ISOLATION_FLAGS = [
  "OPENCODE_DISABLE_PROJECT_CONFIG",
  "OPENCODE_DISABLE_CLAUDE_CODE",
  "OPENCODE_DISABLE_EXTERNAL_SKILLS",
  "OPENCODE_DISABLE_AUTOUPDATE",
  "OPENCODE_DISABLE_SHARE",
  "OPENCODE_DISABLE_LSP_DOWNLOAD",
  "OPENCODE_DISABLE_EMBEDDED_WEB_UI",
];

const GOOGLE_KEY = "GOOGLE_GENERATIVE_AI_API_KEY";
const GOOGLE_KEY_ALIASES = ["GEMINI_API_KEY", "GOOGLE_API_KEY"];

export function serverEnv(
  base: Env,
  dirs: IsolatedDirs,
  extra: Record<string, string>,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(base)) {
    if (value !== undefined) env[name] = value;
  }
  if (!env[GOOGLE_KEY]) {
    const alias = GOOGLE_KEY_ALIASES.map((name) => env[name]).find((value) => value);
    if (alias) env[GOOGLE_KEY] = alias;
  }
  for (const flag of ISOLATION_FLAGS) env[flag] = "1";
  env.OPENCODE_CONFIG_DIR = dirs.config;
  env.XDG_CONFIG_HOME = dirs.config;
  env.XDG_DATA_HOME = dirs.data;
  env.XDG_STATE_HOME = dirs.state;
  return { ...env, ...extra };
}
