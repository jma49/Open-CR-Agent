import { OcraError } from "@open-cr-agent/core";
import { GitHubApiError } from "@open-cr-agent/vcs-github";
import { GitLabApiError } from "@open-cr-agent/vcs-gitlab";
import { GitError } from "@open-cr-agent/vcs-local";
import { describe, expect, it } from "vitest";
import { UsageError } from "./io/usage-error.js";
import { ConfigError } from "./review/config.js";
import { fetchRemoteConfig } from "./review/remote-config.js";

describe("errors across the packages", () => {
  it.each([
    [new UsageError("bad flag"), "UsageError", "INPUT_USAGE"],
    [new ConfigError("bad config"), "ConfigError", "CONFIG_INVALID"],
    [new GitError(["diff"], 128, "fatal"), "GitError", "VCS_GIT_FAILED"],
    [new GitHubApiError(502, "bad gateway"), "GitHubApiError", "VCS_API_FAILED"],
    [new GitLabApiError(502, "bad gateway"), "GitLabApiError", "VCS_API_FAILED"],
  ] as const)("%s is an OcraError with its own name and code", (error, name, code) => {
    expect(error).toBeInstanceOf(OcraError);
    expect(error.name).toBe(name);
    expect(error.code).toBe(code);
  });

  it("a ConfigError keeps its cause", () => {
    const cause = new Error("EACCES");
    expect(new ConfigError("cannot read", { cause }).cause).toBe(cause);
  });

  it("a shared configuration that cannot be used is CONFIG_INVALID", async () => {
    const error = await fetchRemoteConfig("http://example.com/ocra.json").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OcraError);
    expect((error as OcraError).code).toBe("CONFIG_INVALID");
  });
});
