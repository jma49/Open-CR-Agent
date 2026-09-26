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

// What any process needs to run and reach the network, nothing more.
const SYSTEM_VARIABLES = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "TMPDIR",
  "TEMP",
  "TMP",
  "LANG",
  "TZ",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "ALL_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "all_proxy",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "SystemRoot",
  "ComSpec",
  "PATHEXT",
  "APPDATA",
  "LOCALAPPDATA",
  "USERPROFILE",
];

// Credentials OpenCode reads per provider. A provider not listed here gets
// every variable that starts with its uppercased id, such as GROQ_API_KEY.
const PROVIDER_VARIABLES: Record<string, readonly string[]> = {
  google: ["GOOGLE_GENERATIVE_AI_API_KEY"],
  "google-vertex": [
    "GOOGLE_APPLICATION_CREDENTIALS",
    "GOOGLE_CLOUD_PROJECT",
    "GOOGLE_CLOUD_LOCATION",
    "GOOGLE_VERTEX_PROJECT",
    "GOOGLE_VERTEX_LOCATION",
  ],
  "amazon-bedrock": [
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_SESSION_TOKEN",
    "AWS_REGION",
    "AWS_PROFILE",
    "AWS_BEARER_TOKEN_BEDROCK",
  ],
  azure: ["AZURE_API_KEY", "AZURE_RESOURCE_NAME"],
};

const GOOGLE_KEY = "GOOGLE_GENERATIVE_AI_API_KEY";
const GOOGLE_KEY_ALIASES = ["GEMINI_API_KEY", "GOOGLE_API_KEY"];
export const EXTRA_ENV_VARIABLE = "OCRA_RUNTIME_ENV";

// The child sees only what it needs: system basics, the credentials of the
// providers in the configured model chains, and names listed in
// OCRA_RUNTIME_ENV. Other secrets in the user's shell never reach it.
export function serverEnv(
  base: Env,
  dirs: IsolatedDirs,
  providers: readonly string[],
): Record<string, string> {
  const env: Record<string, string> = {};
  const copy = (name: string) => {
    const value = base[name];
    if (value !== undefined) env[name] = value;
  };

  for (const name of SYSTEM_VARIABLES) copy(name);
  for (const name of Object.keys(base)) if (name.startsWith("LC_")) copy(name);
  for (const provider of new Set(providers)) {
    const known = PROVIDER_VARIABLES[provider];
    if (known) {
      for (const name of known) copy(name);
    } else {
      const prefix = `${provider.toUpperCase().replaceAll("-", "_")}_`;
      for (const name of Object.keys(base)) if (name.startsWith(prefix)) copy(name);
    }
  }
  for (const name of (base[EXTRA_ENV_VARIABLE] ?? "").split(",")) {
    if (name.trim() !== "") copy(name.trim());
  }

  if (providers.includes("google") && !env[GOOGLE_KEY]) {
    const alias = GOOGLE_KEY_ALIASES.map((name) => base[name]).find((value) => value);
    if (alias) env[GOOGLE_KEY] = alias;
  }
  for (const flag of ISOLATION_FLAGS) env[flag] = "1";
  env.OPENCODE_CONFIG_DIR = dirs.config;
  env.XDG_CONFIG_HOME = dirs.config;
  env.XDG_DATA_HOME = dirs.data;
  env.XDG_STATE_HOME = dirs.state;
  return env;
}
