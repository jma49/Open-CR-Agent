import { REVIEW_TOOLS } from "@open-cr-agent/core";
import { describe, expect, it } from "vitest";
import { setupName, singleAgentConfig } from "./setup-config.js";
import { plugin, singleAgentReviewer } from "./single-agent.js";

describe("setupName", () => {
  it("takes a known setup and refuses others", () => {
    expect(setupName(undefined)).toBeUndefined();
    expect(setupName("single-agent")).toBe("single-agent");
    expect(() => setupName("solo")).toThrow("--setup must be one of: single-agent");
  });
});

describe("singleAgentConfig", () => {
  it("keeps the user's settings and turns off the verifier and the judge", () => {
    const user = { models: { top: ["a/b"] }, maxCostUsd: 2, verify: true, judge: true };
    expect(singleAgentConfig(user, "/p/single-agent.js")).toEqual({
      models: { top: ["a/b"] },
      maxCostUsd: 2,
      plugins: ["/p/single-agent.js"],
      verify: false,
      judge: false,
    });
    expect(singleAgentConfig(undefined, "/p.js")).toEqual({
      plugins: ["/p.js"],
      verify: false,
      judge: false,
    });
  });

  it("refuses a configuration with plugins or one that is not an object", () => {
    expect(() => singleAgentConfig({ plugins: ["./x.mjs"] }, "/p.js")).toThrow("names plugins");
    expect(() => singleAgentConfig([], "/p.js")).toThrow("JSON object");
  });
});

describe("the single-agent plugin", () => {
  it("registers one top-tier reviewer that reports through the review tools", () => {
    const registered: unknown[] = [];
    plugin.configure?.({
      registerReviewer: (definition: unknown) => registered.push(definition),
    } as never);
    expect(registered).toEqual([singleAgentReviewer]);
    expect(singleAgentReviewer).toMatchObject({ id: "single-agent", modelTier: "top" });
    for (const tool of [REVIEW_TOOLS.reportFinding, REVIEW_TOOLS.taskDone]) {
      expect(singleAgentReviewer.systemPrompt).toContain(tool);
    }
  });
});
