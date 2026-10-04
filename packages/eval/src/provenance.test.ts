import type { RunProvenance } from "@open-cr-agent/core";
import { describe, expect, it } from "vitest";
import {
  type ProvenanceSummary,
  provenanceWarnings,
  renderProvenance,
  summarizeProvenance,
} from "./provenance.js";
import type { InstanceResult } from "./runner.js";

const made: RunProvenance = {
  ocraVersion: "0.3.0",
  promptHash: "p1",
  configHash: "c1",
  sampling: { temperature: 0, notApplied: ["seed"] },
};

function result(
  id: string,
  provenance?: Partial<RunProvenance>,
  status: InstanceResult["status"] = "reviewed",
): InstanceResult {
  return {
    id,
    status,
    durationMs: 0,
    findings: [],
    usage: { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cachedTokens: 0, costUsd: 0 },
    tasks: [],
    ...(provenance ? { provenance: { ...made, ...provenance } } : {}),
  };
}

describe("summarizeProvenance", () => {
  it("lists the distinct values the reviewed PRs recorded", () => {
    expect(
      summarizeProvenance([
        result("a", {}),
        result("b", {}),
        result("c", { ocraVersion: "0.2.0" }),
        result("d", { ocraVersion: "0.1.0" }, "failed"),
        result("e"),
      ]),
    ).toEqual({
      ocraVersion: ["0.2.0", "0.3.0"],
      promptHash: ["p1"],
      configHash: ["c1"],
      sampling: [{ temperature: 0, notApplied: ["seed"] }],
    });
  });

  it("is absent when no review recorded it", () => {
    expect(summarizeProvenance([result("a")])).toBeUndefined();
  });
});

describe("provenanceWarnings", () => {
  const summary = (overrides: Partial<ProvenanceSummary> = {}): ProvenanceSummary => ({
    ocraVersion: ["0.3.0"],
    promptHash: ["p1"],
    configHash: ["c1"],
    sampling: [{ temperature: 0 }],
    ...overrides,
  });

  it("is silent when the runs were made alike, or none recorded it", () => {
    expect(provenanceWarnings([summary(), summary()])).toEqual([]);
    expect(provenanceWarnings([undefined, undefined])).toEqual([]);
  });

  it("names each field that differs", () => {
    expect(
      provenanceWarnings([
        summary(),
        summary({
          ocraVersion: ["0.4.0"],
          promptHash: ["p2"],
          configHash: ["c2"],
          sampling: [{ temperature: 1 }],
        }),
      ]),
    ).toEqual([
      'the runs were made with different ocra versions: ["0.3.0"] vs ["0.4.0"]',
      'the runs were made with different prompts (promptHash): ["p1"] vs ["p2"]',
      'the runs were made with different configurations (configHash): ["c1"] vs ["c2"]',
      'the runs were made with different sampling settings: [{"temperature":0}] vs [{"temperature":1}]',
    ]);
  });

  it("says when a run mixes setups, or another recorded nothing", () => {
    const mixed = summary({ promptHash: ["p1", "p2"] });
    expect(provenanceWarnings([mixed, mixed])).toEqual([
      "a run mixes reviews made with different prompts (promptHash); it was resumed after a change",
    ]);
    expect(provenanceWarnings([summary(), undefined])).toEqual([
      "some runs record no provenance (ocra version, prompts, configuration, sampling), so those cannot be compared",
    ]);
  });
});

describe("renderProvenance", () => {
  it("shows the sampling applied and what was not", () => {
    expect(renderProvenance(summarizeProvenance([result("a", {})]))).toBe(
      "ocra 0.3.0 · prompts p1 · config c1 · sampling temperature 0, not applied: seed",
    );
    expect(renderProvenance(undefined)).toBe("not recorded");
  });
});
