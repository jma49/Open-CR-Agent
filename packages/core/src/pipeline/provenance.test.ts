import { describe, expect, it } from "vitest";
import { correctnessReviewer } from "../review/reviewers/correctness.js";
import { securityReviewer } from "../review/reviewers/security.js";
import { appliedSampling, promptHash, stableHash } from "./provenance.js";
import { patch, runtime, vcs } from "./run.fakes.js";
import { review } from "./run.js";

describe("stableHash", () => {
  it("does not depend on the order keys were written in", () => {
    expect(stableHash({ a: 1, b: { c: [1, 2], d: "x" } })).toBe(
      stableHash({ b: { d: "x", c: [1, 2] }, a: 1 }),
    );
    expect(stableHash({ a: 1 })).not.toBe(stableHash({ a: 2 }));
    expect(stableHash({ a: 1, b: undefined })).toBe(stableHash({ a: 1 }));
  });
});

describe("promptHash", () => {
  const reviewers = [correctnessReviewer, securityReviewer];

  it("changes with a reviewer's instructions and ignores disabled reviewers", () => {
    const base = promptHash(reviewers);
    expect(promptHash([securityReviewer, correctnessReviewer])).toBe(base);
    const edited = { ...correctnessReviewer, systemPrompt: `${correctnessReviewer.systemPrompt}!` };
    expect(promptHash([edited, securityReviewer])).not.toBe(base);
    expect(promptHash(reviewers, { security: { enabled: false } })).toBe(
      promptHash([correctnessReviewer]),
    );
    expect(promptHash(reviewers, { security: { minTier: "full" } })).toBe(base);
  });
});

describe("appliedSampling", () => {
  it("takes what the runtime says it applied", () => {
    const sampling = { temperature: 0, notApplied: ["seed" as const] };
    expect(appliedSampling({ sampling }, { temperature: 0, seed: 1 })).toBe(sampling);
  });

  it("reports a runtime that says nothing as applying nothing requested", () => {
    expect(appliedSampling({}, { temperature: 0, seed: 1 })).toEqual({
      notApplied: ["temperature", "seed"],
    });
    expect(appliedSampling({})).toEqual({});
  });
});

describe("review provenance", () => {
  const done = runtime(async function* (spec) {
    yield { type: "done", taskId: spec.taskId };
  });

  it("is in the report when the caller supplies its version and configuration hash", async () => {
    const options = {
      vcs: vcs({}, patch("src/a.ts", "const a = 1;")),
      runtime: Object.assign(done, { sampling: { temperature: 0, seed: 7 } }),
      reviewers: [correctnessReviewer],
      verify: false,
      judge: false,
    };
    expect((await review(options)).provenance).toBeUndefined();
    const report = await review({
      ...options,
      provenance: { ocraVersion: "1.2.3", configHash: "c0ffee", sampling: { temperature: 0 } },
    });
    expect(report.provenance).toEqual({
      ocraVersion: "1.2.3",
      promptHash: promptHash([correctnessReviewer]),
      configHash: "c0ffee",
      sampling: { temperature: 0, seed: 7 },
      agents: {
        correctness: { tier: "standard" },
        verifier: { tier: "standard" },
        judge: { tier: "top" },
        helper: { tier: "light" },
      },
    });
  });

  it("lists the rules with their source, and the account settings' version", async () => {
    const report = await review({
      vcs: vcs(
        { ".ocra/rules.json": JSON.stringify({ rules: [{ path: "src/**", rule: "File rule." }] }) },
        patch("src/a.ts", "const a = 1;"),
      ),
      runtime: done,
      reviewers: [correctnessReviewer],
      verify: false,
      judge: false,
      rules: [
        { path: ["lib/**", "src/**"], rule: "Account rule.", source: "account" },
        { path: "**", rule: "Unsourced rule." },
      ],
      provenance: { ocraVersion: "1", configHash: "c", accountSettings: { version: null } },
    });
    expect(report.provenance?.rules).toEqual([
      { path: ["lib/**", "src/**"], rule: "Account rule.", source: "account" },
      { path: ["**"], rule: "Unsourced rule." },
      { path: ["src/**"], rule: "File rule.", source: "repository" },
    ]);
    expect(report.provenance?.accountSettings).toEqual({ version: null });
  });
});
