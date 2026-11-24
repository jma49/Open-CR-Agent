import { OcraError } from "@open-cr-agent/core";
import { describe, expect, it } from "vitest";
import { codexEnv } from "./env.js";
import { execArgs, featuresToDisable, TOOL_TOKEN_ENV } from "./exec-args.js";

function overrides(args: readonly string[]): string[] {
  return args.flatMap((a, i) => (args[i - 1] === "-c" ? [a] : []));
}

describe("execArgs", () => {
  it("runs one read-only exec that leaves the user's config, rules and history alone", () => {
    const args = execArgs({ instructionsFile: "/tmp/i.md", disabled: ["shell_tool"] });
    expect(args.slice(0, 9)).toEqual([
      "exec",
      "--json",
      "--ephemeral",
      "--skip-git-repo-check",
      "--ignore-user-config",
      "--ignore-rules",
      "--sandbox",
      "read-only",
      "--disable",
    ]);
    expect(args.at(-1)).toBe("-");
    expect(args).not.toContain("--model");
    expect(overrides(args)).toContain('model_instructions_file="/tmp/i.md"');
    expect(overrides(args)).toContain('web_search="disabled"');
    expect(overrides(args).some((c) => c.startsWith("mcp_servers."))).toBe(false);
  });

  it("gives Codex ocra's tool server, its token by variable, its tools approved", () => {
    const args = execArgs({
      model: "gpt-5.5",
      instructionsFile: "C:\\t\\i.md",
      disabled: [],
      toolsUrl: "http://127.0.0.1:4000/mcp",
      config: ['model_provider="mock"'],
    });
    expect(args.slice(args.indexOf("--model"), args.indexOf("--model") + 2)).toEqual([
      "--model",
      "gpt-5.5",
    ]);
    expect(overrides(args)).toEqual([
      'model_instructions_file="C:\\\\t\\\\i.md"',
      'web_search="disabled"',
      "skills.include_instructions=false",
      "tools.experimental_request_user_input.enabled=false",
      "tools.update_plan.enabled=false",
      'mcp_servers.ocra.url="http://127.0.0.1:4000/mcp"',
      `mcp_servers.ocra.bearer_token_env_var="${TOOL_TOKEN_ENV}"`,
      "mcp_servers.ocra.required=true",
      'mcp_servers.ocra.default_tools_approval_mode="approve"',
      'model_provider="mock"',
    ]);
  });
});

describe("featuresToDisable", () => {
  it("switches off the shell and every other tool feature this Codex knows", () => {
    const known = new Set(["shell_tool", "unified_exec", "apps", "view_image", "fast_mode"]);
    expect(featuresToDisable(known)).toEqual(["shell_tool", "unified_exec", "apps", "view_image"]);
  });

  it("refuses a Codex whose shell cannot be switched off", () => {
    expect(() => featuresToDisable(new Set(["shell_tool"]))).toThrow(OcraError);
    expect(() => featuresToDisable(new Set(["shell_tool"]))).toThrow(/unified_exec/);
  });
});

describe("codexEnv", () => {
  it("passes what finds the sign-in and the network, and no API key", () => {
    expect(
      codexEnv({
        PATH: "/bin",
        HOME: "/h",
        CODEX_HOME: "/h/.codex",
        HTTPS_PROXY: "http://p",
        OPENAI_API_KEY: "sk-1",
        OPENAI_BASE_URL: "http://x",
        CODEX_API_KEY: "sk-2",
        GITHUB_TOKEN: "ghp",
        EMPTY: undefined,
      }),
    ).toEqual({ PATH: "/bin", HOME: "/h", CODEX_HOME: "/h/.codex", HTTPS_PROXY: "http://p" });
  });

  it("passes the key of a model provider the overrides declare", () => {
    expect(
      codexEnv({ PATH: "/bin", GW_KEY: "k", OTHER: "o" }, ['model_providers.gw.env_key="GW_KEY"']),
    ).toEqual({ PATH: "/bin", GW_KEY: "k" });
  });
});
