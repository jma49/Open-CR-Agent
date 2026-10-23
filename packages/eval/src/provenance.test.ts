import type { RunProvenance } from "@open-cr-agent/core";
import { describe, expect, it } from "vitest";
import type { OcraBuild } from "./ocra-build.js";
import {
  mixedSetups,
  type ProvenanceSummary,
  provenanceWarnings,
  renderProvenance,
  summarizeProvenance,
} from "./provenance.js";
import type { InstanceResult } from "./results.js";

const made: RunProvenance = {
  ocraVersion: "0.3.0",
  promptHash: "p1",
  configHash: "c1",
  sampling: { temperature: 0, notApplied: ["seed"] },
};

const A = "a".repeat(40);
const B = "b".repeat(40);

function result(
  id: string,
  provenance?: Partial<RunProvenance>,
  status: InstanceResult["status"] = "reviewed",
  ocra?: OcraBuild,
): InstanceResult {
  return {
    id,
    status,
    durationMs: 0,
    findings: [],
    usage: { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cachedTokens: 0, costUsd: 0 },
    tasks: [],
    ...(provenance ? { provenance: { ...made, ...provenance } } : {}),
    ...(ocra ? { ranOn: { at: "2026-10-23T00:00:00.000Z", ocra, runtime: "opencode" } } : {}),
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

  it("adds each agent's models from the reports and what the reviews ran on", () => {
    const agents = {
      security: {
        tier: "standard" as const,
        models: ["m/b"],
        effort: "high" as const,
        applied: true,
      },
      correctness: { tier: "standard" as const, models: ["m/a", "m/b"] },
    };
    const build = { version: "0.7.0", commit: A, dirty: false, maxAgentSteps: 30 };
    expect(
      summarizeProvenance([
        result("a", { agents }, "reviewed", build),
        result("b", { agents }, "reviewed", build),
      ]),
    ).toEqual({
      ocraVersion: ["0.3.0"],
      promptHash: ["p1"],
      configHash: ["c1"],
      sampling: [{ temperature: 0, notApplied: ["seed"] }],
      agents: [
        {
          correctness: { tier: "standard", models: ["m/a", "m/b"] },
          security: { tier: "standard", models: ["m/b"], effort: "high" },
        },
      ],
      ocra: [build],
      runtime: ["opencode"],
    });
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

  it("says when a run recorded nothing, or less than another", () => {
    expect(provenanceWarnings([summary(), undefined])).toEqual([
      "some runs record no provenance (ocra version, prompts, configuration, sampling), so those cannot be compared",
    ]);
    expect(provenanceWarnings([summary(), summary({ runtime: ["opencode"] })])).toEqual([
      "some runs record no runtimes: an older ocra-eval made them, so those cannot be compared",
    ]);
  });

  it("compares what the reviews ran on, builds only when asked", () => {
    const on = (commit: string, input: number, dirty = false) =>
      summary({
        ocra: [{ version: "0.7.0", commit, dirty, maxAgentSteps: 30 }],
        runtime: ["opencode"],
        opencode: [{ version: "1.18.32" }],
        agents: [{ correctness: { tier: "standard", models: ["anthropic/claude-haiku-5-5"] } }],
        catalog: [{ "anthropic/claude-haiku-5-5": { cost: { input, output: 5 } } }],
      });
    expect(provenanceWarnings([on(A, 1), on(B, 1)])).toEqual([]);
    expect(provenanceWarnings([on(A, 1), on(B, 1)], { builds: true })).toEqual([
      "the runs were made with different ocra builds: 0.7.0 at aaaaaaaaaaaa, 30 steps per review agent vs 0.7.0 at bbbbbbbbbbbb, 30 steps per review agent",
    ]);
    const [warning, ...rest] = provenanceWarnings([on(A, 1), on(A, 2, true)]);
    expect(warning).toMatch(
      /^the runs were made with different OpenCode catalog entries: anthropic\/claude-haiku-5-5 \$1\/\$5 \[[0-9a-f]{8}\] vs anthropic\/claude-haiku-5-5 \$2\/\$5 \[[0-9a-f]{8}\]$/,
    );
    expect(rest).toEqual([
      "a run was made by an ocra checkout with uncommitted changes, which its commit does not identify",
    ]);
  });
});

describe("mixedSetups", () => {
  const build = (commit: string) => ({ version: "0.7.0", commit, maxAgentSteps: 30 });

  it("names what differs among the reviews of one setup", () => {
    expect(mixedSetups([summarizeProvenance([result("a", {}, "reviewed", build(A))])])).toEqual([]);
    const resumed = summarizeProvenance([
      result("a", {}, "reviewed", build(A)),
      result("b", { promptHash: "p2" }, "reviewed", build(B)),
    ]);
    expect(mixedSetups([resumed])).toEqual([
      'its reviews were made with different prompts (promptHash): "p1" vs "p2"',
      "its reviews were made with different ocra builds: 0.7.0 at aaaaaaaaaaaa, 30 steps per review agent vs 0.7.0 at bbbbbbbbbbbb, 30 steps per review agent",
    ]);
  });

  it("counts a review that recorded no setup as another, and repetitions as one run", () => {
    const resumed = summarizeProvenance([result("a", {}), result("b", {}, "reviewed", build(B))]);
    expect(mixedSetups([resumed])).toEqual([
      "its reviews were made with different ocra builds: not recorded vs 0.7.0 at bbbbbbbbbbbb, 30 steps per review agent",
      "its reviews were made with different runtimes: opencode vs not recorded",
    ]);
    const r1 = summarizeProvenance([result("a", {}, "reviewed", build(A))]);
    const r2 = summarizeProvenance([result("a", {}, "reviewed", build(B))]);
    expect(mixedSetups([r1, r2])).toHaveLength(1);
    expect(mixedSetups([r1, undefined])).toEqual([]);
  });
});

describe("renderProvenance", () => {
  it("shows the sampling applied and what was not", () => {
    expect(renderProvenance(summarizeProvenance([result("a", {})]))).toBe(
      "ocra 0.3.0 · prompts p1 · config c1 · sampling temperature 0, not applied: seed",
    );
    expect(renderProvenance(undefined)).toBe("not recorded");
  });

  it("shows what the reviews ran on", () => {
    const agents = { correctness: { tier: "standard" as const, models: ["m/a", "m/b"] } };
    const build = { version: "0.7.0", commit: A, maxAgentSteps: 30 };
    expect(
      renderProvenance(
        summarizeProvenance([result("a", { agents }, "reviewed", build), result("b", { agents })]),
      ),
    ).toBe(
      "ocra 0.3.0 · prompts p1 · config c1 · sampling temperature 0, not applied: seed · build not recorded; aaaaaaaaaaaa · runtime opencode; not recorded · models m/a > m/b",
    );
  });
});
