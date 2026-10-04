import type { CustomProvider, Env } from "@open-cr-agent/core";

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

// Providers that cannot work without one of these variables. Without it
// OpenCode silently skips the provider and later reports "model not found".
const REQUIRED_KEYS: Record<string, readonly string[]> = {
  google: ["GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY"],
  anthropic: ["ANTHROPIC_API_KEY"],
  openai: ["OPENAI_API_KEY"],
  openrouter: ["OPENROUTER_API_KEY"],
  groq: ["GROQ_API_KEY"],
  mistral: ["MISTRAL_API_KEY"],
  deepseek: ["DEEPSEEK_API_KEY"],
  xai: ["XAI_API_KEY"],
  azure: ["AZURE_API_KEY"],
};

type CustomProviders = Readonly<Record<string, CustomProvider>>;

export function missingCredentials(
  base: Env,
  providers: readonly string[],
  custom: CustomProviders = {},
): string[] {
  return [...new Set(providers)].flatMap((provider) => {
    const declared = custom[provider];
    if (declared) {
      const name = declared.apiKeyEnv;
      return name && !base[name] ? [`No API key for provider "${provider}": set ${name}`] : [];
    }
    const names = REQUIRED_KEYS[provider];
    if (!names || names.some((name) => base[name])) return [];
    return [`No API key for provider "${provider}": set ${names.join(" or ")}`];
  });
}

const GOOGLE_KEY = "GOOGLE_GENERATIVE_AI_API_KEY";
const GOOGLE_KEY_ALIASES = ["GEMINI_API_KEY", "GOOGLE_API_KEY"];
const EXTRA_ENV_VARIABLE = "OCRA_RUNTIME_ENV";
// OpenCode installs its plugin package from npm into every config directory
// when it starts, and the SDK of a provider it does not bundle when a model
// first uses it; no flag turns either off. ocra loads no OpenCode plugins and
// supports only bundled providers, so both installs get the discard port on
// this machine as their registry, and no retries: they fail at once, no code
// is fetched at review time and no .npmrc token is sent (docs/spikes/0002).
const NPM_SETTINGS = {
  npm_config_registry: "http://127.0.0.1:9/",
  NPM_CONFIG_REGISTRY: "http://127.0.0.1:9/",
  npm_config_fetch_retries: "0",
};

// A model chain naming a provider such as "github", "gitlab" or "aws" must
// not carry the CI's or the cloud's credentials across by prefix (GitLab CI
// puts CI_JOB_TOKEN and CI_REGISTRY_PASSWORD in every job); name them in
// OCRA_RUNTIME_ENV when they are really meant for a provider.
const NEVER_BY_PREFIX = [
  "GITHUB_",
  "GH_",
  "ACTIONS_",
  "RUNNER_",
  "GITLAB_",
  "CI_",
  "AWS_",
  "AZURE_",
  "NPM_",
  "SSH_",
  "OCRA_",
];

// The variables that carry the credentials of the configured providers: for
// a provider declared in configuration only the one it names, for a known
// catalog provider its variables, for any other every variable with its
// prefix that is not a platform token.
function credentialNames(
  base: Env,
  providers: readonly string[],
  custom: CustomProviders = {},
): string[] {
  const names: string[] = [];
  for (const provider of new Set(providers)) {
    const declared = custom[provider];
    if (declared) {
      if (declared.apiKeyEnv) names.push(declared.apiKeyEnv);
      continue;
    }
    const known = PROVIDER_VARIABLES[provider];
    if (known) {
      names.push(...known);
    } else {
      const prefix = `${provider.toUpperCase().replaceAll("-", "_")}_`;
      for (const name of Object.keys(base)) {
        if (name.startsWith(prefix) && !NEVER_BY_PREFIX.some((p) => name.startsWith(p))) {
          names.push(name);
        }
      }
    }
  }
  return names;
}

// The credential values themselves, to redact from what a provider says.
// Values shorter than a key could be ordinary words and are left alone.
export function credentialValues(
  base: Env,
  providers: readonly string[],
  custom: CustomProviders = {},
): string[] {
  const names = credentialNames(base, providers, custom);
  if (providers.includes("google") && !custom.google) names.push(...GOOGLE_KEY_ALIASES);
  return names
    .map((name) => base[name])
    .filter((value): value is string => value !== undefined && value.length >= 8);
}

// The child sees only what it needs: system basics, the credentials of the
// providers in the configured model chains (for a provider declared in
// configuration, only the variable it names), and names listed in
// OCRA_RUNTIME_ENV. Other secrets in the user's shell never reach it.
export function serverEnv(
  base: Env,
  dirs: IsolatedDirs,
  providers: readonly string[],
  custom: CustomProviders = {},
): Record<string, string> {
  const env: Record<string, string> = {};
  const copy = (name: string) => {
    const value = base[name];
    if (value !== undefined) env[name] = value;
  };

  for (const name of SYSTEM_VARIABLES) copy(name);
  for (const name of Object.keys(base)) if (name.startsWith("LC_")) copy(name);
  for (const name of credentialNames(base, providers, custom)) copy(name);
  for (const name of (base[EXTRA_ENV_VARIABLE] ?? "").split(",")) {
    if (name.trim() !== "") copy(name.trim());
  }

  if (providers.includes("google") && !custom.google && !env[GOOGLE_KEY]) {
    const alias = GOOGLE_KEY_ALIASES.map((name) => base[name]).find((value) => value);
    if (alias) env[GOOGLE_KEY] = alias;
  }
  for (const flag of ISOLATION_FLAGS) env[flag] = "1";
  Object.assign(env, NPM_SETTINGS);
  env.OPENCODE_CONFIG_DIR = dirs.config;
  env.XDG_CONFIG_HOME = dirs.config;
  env.XDG_DATA_HOME = dirs.data;
  env.XDG_STATE_HOME = dirs.state;
  return env;
}
