import { describe, expect, it } from "vitest";
import { serverEnv } from "./server-env.js";

const dirs = { config: "/t/config", data: "/t/data", state: "/t/state" };

describe("serverEnv", () => {
  it("maps Gemini keys to the variable OpenCode reads", () => {
    expect(serverEnv({ GEMINI_API_KEY: "g" }, dirs, {}).GOOGLE_GENERATIVE_AI_API_KEY).toBe("g");
    expect(serverEnv({ GOOGLE_API_KEY: "a" }, dirs, {}).GOOGLE_GENERATIVE_AI_API_KEY).toBe("a");
    expect(
      serverEnv({ GOOGLE_GENERATIVE_AI_API_KEY: "direct", GEMINI_API_KEY: "g" }, dirs, {})
        .GOOGLE_GENERATIVE_AI_API_KEY,
    ).toBe("direct");
  });

  it("isolates OpenCode from the user's configuration and the repository", () => {
    const env = serverEnv(
      { HOME: "/home/u", XDG_CONFIG_HOME: "/home/u/.config", PATH: "/bin", UNSET: undefined },
      dirs,
      {
        EXTRA: "1",
      },
    );
    expect(env).toMatchObject({
      HOME: "/home/u",
      PATH: "/bin",
      EXTRA: "1",
      OPENCODE_CONFIG_DIR: "/t/config",
      XDG_CONFIG_HOME: "/t/config",
      XDG_DATA_HOME: "/t/data",
      XDG_STATE_HOME: "/t/state",
      OPENCODE_DISABLE_PROJECT_CONFIG: "1",
      OPENCODE_DISABLE_CLAUDE_CODE: "1",
      OPENCODE_DISABLE_EXTERNAL_SKILLS: "1",
      OPENCODE_DISABLE_SHARE: "1",
    });
    expect("UNSET" in env).toBe(false);
  });
});
