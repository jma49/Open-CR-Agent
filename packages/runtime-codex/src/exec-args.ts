import { OcraError } from "@open-cr-agent/core";

// The MCP server name Codex is given for ocra's review tools; it reports
// their calls under it.
export const OCRA_SERVER = "ocra";
// Codex reads the tool server's bearer token from this variable.
export const TOOL_TOKEN_ENV = "OCRA_CODEX_TOOL_TOKEN";

// Codex's own tools. A reviewer reads the change only through ocra's tools,
// which see the checkout ocra prepared and nothing else on the machine.
const REQUIRED_OFF = ["shell_tool", "unified_exec"] as const;
// What else this Codex offers is switched off when it knows the feature.
const ALSO_OFF = [
  "apps",
  "plugins",
  "hooks",
  "browser_use",
  "browser_use_external",
  "computer_use",
  "in_app_browser",
  "image_generation",
  "view_image",
  "multi_agent",
  "goals",
  "sleep_tool",
  "skill_search",
  "tool_suggest",
  "workspace_dependencies",
  "skill_mcp_dependency_install",
  "code_mode_host",
] as const;

// The features to pass to --disable, from `codex features list`. Codex
// rejects a feature it does not know, so only known ones are named; without
// a way to switch its shell off, the runtime does not start.
export function featuresToDisable(known: ReadonlySet<string>): string[] {
  const missing = REQUIRED_OFF.filter((f) => !known.has(f));
  if (missing.length > 0) {
    throw new OcraError(
      "RUNTIME_START_FAILED",
      `This Codex cannot switch off its own ${missing.join(" and ")}, which a review needs; update Codex`,
    );
  }
  return [...REQUIRED_OFF, ...ALSO_OFF.filter((f) => known.has(f))];
}

export interface ExecArgsInput {
  // Absent: Codex's own default model.
  model?: string;
  // The system prompt, in place of Codex's own instructions.
  instructionsFile: string;
  disabled: readonly string[];
  // ocra's tool server; absent for a plain completion, which uses no tools.
  toolsUrl?: string;
  // More `-c key=value` overrides, after ocra's own.
  config?: readonly string[];
}

// One `codex exec` that reads its prompt from stdin and writes JSON lines.
// It leaves the user's config.toml, rules and session history alone: their
// MCP servers, hooks and plugins do not join a review, and the review does
// not show among their sessions.
export function execArgs(input: ExecArgsInput): string[] {
  const config = [
    `model_instructions_file=${toml(input.instructionsFile)}`,
    'web_search="disabled"',
    "skills.include_instructions=false",
    "tools.experimental_request_user_input.enabled=false",
    "tools.update_plan.enabled=false",
    ...(input.toolsUrl === undefined ? [] : toolServerConfig(input.toolsUrl)),
    ...(input.config ?? []),
  ];
  return [
    "exec",
    "--json",
    "--ephemeral",
    "--skip-git-repo-check",
    "--ignore-user-config",
    "--ignore-rules",
    "--sandbox",
    "read-only",
    ...input.disabled.flatMap((f) => ["--disable", f]),
    ...config.flatMap((c) => ["-c", c]),
    ...(input.model === undefined ? [] : ["--model", input.model]),
    "-",
  ];
}

// Codex asks before an MCP tool runs and, in exec, refuses what it would ask
// about; ocra's tools only read the change and record findings.
function toolServerConfig(url: string): string[] {
  const server = `mcp_servers.${OCRA_SERVER}`;
  return [
    `${server}.url=${toml(url)}`,
    `${server}.bearer_token_env_var=${toml(TOOL_TOKEN_ENV)}`,
    `${server}.required=true`,
    `${server}.default_tools_approval_mode="approve"`,
  ];
}

// A TOML basic string: JSON's escapes are valid in one.
function toml(value: string): string {
  return JSON.stringify(value);
}
