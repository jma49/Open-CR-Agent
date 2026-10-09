import { describe, expect, it } from "vitest";
import { credentialEnvironment, gitEnvironment, supportsAttrSource } from "./git.js";

describe("gitEnvironment", () => {
  it("keeps git's own, ssh's and the system's variables and drops the rest", () => {
    const env = gitEnvironment({
      PATH: "/bin",
      Path: "C:\\Windows",
      HOME: "/home/me",
      GIT_SSH_COMMAND: "ssh -i key",
      GIT_CONFIG_COUNT: "1",
      SSH_AUTH_SOCK: "/tmp/agent",
      https_proxy: "http://proxy:3128",
      SystemRoot: "C:\\Windows",
      OPENAI_API_KEY: "sk-test",
      GITHUB_TOKEN: "ghs_test",
      OCRA_CLOUD: "on",
      UNSET: undefined,
    });
    expect(Object.keys(env).sort()).toEqual(
      [
        "PATH",
        "Path",
        "HOME",
        "GIT_SSH_COMMAND",
        "GIT_CONFIG_COUNT",
        "SSH_AUTH_SOCK",
        "https_proxy",
        "SystemRoot",
      ].sort(),
    );
  });
});

describe("supportsAttrSource", () => {
  it("is true from git 2.41 on", () => {
    expect(supportsAttrSource("git version 2.39.5 (Apple Git-154)")).toBe(false);
    expect(supportsAttrSource("git version 2.40.1")).toBe(false);
    expect(supportsAttrSource("git version 2.41.0")).toBe(true);
    expect(supportsAttrSource("git version 2.47.1.windows.1")).toBe(true);
    expect(supportsAttrSource("git version 3.0.0")).toBe(true);
    expect(supportsAttrSource("not git")).toBe(false);
  });
});

describe("credentialEnvironment", () => {
  it("keeps what credential helpers read and drops model keys", () => {
    const env = credentialEnvironment({
      GH_TOKEN: "a",
      GITHUB_TOKEN: "b",
      GITLAB_TOKEN: "c",
      GCM_INTERACTIVE: "never",
      OPENAI_API_KEY: "sk-test",
      OCRA_CLOUD_TOKEN: "d",
    });
    expect(Object.keys(env).sort()).toEqual(
      ["GCM_INTERACTIVE", "GH_TOKEN", "GITHUB_TOKEN", "GITLAB_TOKEN"].sort(),
    );
  });
});
