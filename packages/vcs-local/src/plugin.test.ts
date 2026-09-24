import { startPlugins } from "@open-cr-agent/core";
import { describe, expect, it } from "vitest";
import { LocalGitAdapter } from "./local-adapter.js";
import { findRepositoryRoot, localGitPlugin } from "./plugin.js";

describe("localGitPlugin", () => {
  it("registers the local VCS and validates its options", async () => {
    const registry = await startPlugins([localGitPlugin]);
    expect(registry.createVcs("local", { cwd: ".", target: { mode: "workspace" } })).toBeInstanceOf(
      LocalGitAdapter,
    );
    expect(() =>
      registry.createVcs("local", { cwd: ".", target: { mode: "range", from: "main" } }),
    ).toThrow();
  });

  it("finds the repository root", async () => {
    expect(await findRepositoryRoot(process.cwd())).toMatch(/\S/);
  });
});
