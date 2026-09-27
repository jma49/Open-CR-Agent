import { describe, expect, it } from "vitest";
import { missingCredentials, serverEnv } from "./server-env.js";

const dirs = { config: "/t/config", data: "/t/data", state: "/t/state" };

describe("missingCredentials", () => {
  it("names the variables to set for providers without a key", () => {
    expect(missingCredentials({ OPENAI_API_KEY: "o" }, ["google", "openai", "ollama"])).toEqual([
      'No API key for provider "google": set GEMINI_API_KEY or GOOGLE_API_KEY or GOOGLE_GENERATIVE_AI_API_KEY',
    ]);
    expect(missingCredentials({ GEMINI_API_KEY: "g" }, ["google", "google"])).toEqual([]);
  });
});

describe("serverEnv", () => {
  it("maps Gemini keys to the variable OpenCode reads", () => {
    const key = (base: Record<string, string>) =>
      serverEnv(base, dirs, ["google"]).GOOGLE_GENERATIVE_AI_API_KEY;
    expect(key({ GEMINI_API_KEY: "g" })).toBe("g");
    expect(key({ GOOGLE_API_KEY: "a" })).toBe("a");
    expect(key({ GOOGLE_GENERATIVE_AI_API_KEY: "direct", GEMINI_API_KEY: "g" })).toBe("direct");
  });

  it("passes only system variables and the configured providers' credentials", () => {
    const env = serverEnv(
      {
        PATH: "/bin",
        HOME: "/home/u",
        LC_ALL: "C",
        HTTPS_PROXY: "http://proxy",
        GEMINI_API_KEY: "g",
        ANTHROPIC_API_KEY: "a",
        OPENAI_API_KEY: "o",
        AWS_SECRET_ACCESS_KEY: "aws",
        GITHUB_TOKEN: "gh",
        DATABASE_URL: "postgres://secret",
        UNSET: undefined,
      },
      dirs,
      ["google", "anthropic"],
    );
    expect(env).toMatchObject({
      PATH: "/bin",
      HOME: "/home/u",
      LC_ALL: "C",
      HTTPS_PROXY: "http://proxy",
      GOOGLE_GENERATIVE_AI_API_KEY: "g",
      ANTHROPIC_API_KEY: "a",
    });
    for (const leaked of [
      "OPENAI_API_KEY",
      "AWS_SECRET_ACCESS_KEY",
      "GITHUB_TOKEN",
      "DATABASE_URL",
      "GEMINI_API_KEY",
      "UNSET",
    ]) {
      expect(leaked in env).toBe(false);
    }
  });

  it("passes an unknown provider's variables by prefix, but never CI or cloud credentials", () => {
    const env = serverEnv(
      { GROQ_API_KEY: "g", GITHUB_TOKEN: "t", GITHUB_API_KEY: "x", AWS_SECRET_ACCESS_KEY: "s" },
      dirs,
      ["groq", "github", "aws"],
    );
    expect(env.GROQ_API_KEY).toBe("g");
    for (const name of ["GITHUB_TOKEN", "GITHUB_API_KEY", "AWS_SECRET_ACCESS_KEY"]) {
      expect(name in env).toBe(false);
    }
    // Named explicitly, a variable still passes.
    expect(
      serverEnv({ GITHUB_API_KEY: "x", OCRA_RUNTIME_ENV: "GITHUB_API_KEY" }, dirs, ["github"]),
    ).toMatchObject({ GITHUB_API_KEY: "x" });
  });

  it("passes names listed in OCRA_RUNTIME_ENV", () => {
    const env = serverEnv(
      { OCRA_RUNTIME_ENV: "CUSTOM_BASE_URL, OTHER", CUSTOM_BASE_URL: "u" },
      dirs,
      [],
    );
    expect(env.CUSTOM_BASE_URL).toBe("u");
    expect("OTHER" in env).toBe(false);
  });

  it("isolates OpenCode from the user's configuration and the repository", () => {
    const env = serverEnv({ XDG_CONFIG_HOME: "/home/u/.config" }, dirs, []);
    expect(env).toMatchObject({
      OPENCODE_CONFIG_DIR: "/t/config",
      XDG_CONFIG_HOME: "/t/config",
      XDG_DATA_HOME: "/t/data",
      XDG_STATE_HOME: "/t/state",
      OPENCODE_DISABLE_PROJECT_CONFIG: "1",
      OPENCODE_DISABLE_CLAUDE_CODE: "1",
      OPENCODE_DISABLE_EXTERNAL_SKILLS: "1",
      OPENCODE_DISABLE_SHARE: "1",
    });
  });
});
