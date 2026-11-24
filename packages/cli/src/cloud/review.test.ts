import { MAX_RULE_TEXT } from "@open-cr-agent/cloud-contract";
import { finding, priorFinding, reviewReport } from "@open-cr-agent/test-support";
import { describe, expect, it } from "vitest";
import { cloudUpload } from "./review.js";

const report = reviewReport({
  learnings: [
    { id: "retry-budget", title: "Retries share one budget", critical: false, bundles: [] },
  ],
  mergeChecks: [
    {
      id: "notes",
      instruction: "Say who is affected.",
      outcome: "failed",
      reason: "It logs api_key=sk-live-0123456789abcdef and says nothing.",
    },
  ],
});
const cloud = (shareFindings: boolean) => ({
  repository: "https://github.com/octo/app",
  repoHash: "8d969eef6ecad3c29a3a629280e686cf0c3f5d5a86aff3ca12020c923adc6c92",
  shareFindings,
});
const local = { source: "local" as const, durationMs: 1 };
const pull = { source: "github" as const, durationMs: 1, changeRequestNumber: 42 };

describe("cloudUpload", () => {
  it("names the learnings and the check outcomes with a pull request, the reasons only with the findings", () => {
    const counts = cloudUpload(report, cloud(false), pull).upload;
    expect(counts.learnings).toEqual(["retry-budget"]);
    expect(counts.mergeChecks).toEqual([{ id: "notes", outcome: "failed" }]);
    const shared = cloudUpload(report, cloud(true), pull).upload;
    expect(shared.mergeChecks).toEqual([
      {
        id: "notes",
        outcome: "failed",
        reason: "It logs api_key=[redacted] and says nothing.",
        redacted: true,
      },
    ]);
  });

  it("names the learnings of a local review only with the findings, and sends no checks", () => {
    expect(cloudUpload(report, cloud(false), local).upload).not.toHaveProperty("learnings");
    const shared = cloudUpload(report, cloud(true), local).upload;
    expect(shared.learnings).toEqual(["retry-budget"]);
    expect(shared).not.toHaveProperty("mergeChecks");
  });

  it("says no learning applied, rather than nothing, when none did", () => {
    const upload = cloudUpload(reviewReport({}), cloud(false), pull).upload;
    expect(upload.learnings).toEqual([]);
    expect(upload).not.toHaveProperty("mergeChecks");
  });

  it("names the earlier findings it saw fixed or dismissed only with the findings", () => {
    const prior = (fingerprint: string) => priorFinding({ fingerprint, title: "t", file: "a.ts" });
    const rereviewed = reviewReport({
      rereview: {
        fixed: [prior("aaaabbbbccccdddd"), prior("1111222233334444")],
        dismissed: [prior("1111222233334444"), prior("eeeeffff00001111")],
        notReproduced: [],
        notRechecked: [],
        unchanged: [],
      },
    });
    expect(cloudUpload(rereviewed, cloud(false), pull).upload.outcomes).toEqual({
      fixed: 1,
      dismissed: 2,
    });
    expect(cloudUpload(rereviewed, cloud(true), pull).upload.outcomes).toEqual({
      fixed: 1,
      dismissed: 2,
      fixedFingerprints: ["aaaabbbbccccdddd"],
      dismissedFingerprints: ["1111222233334444", "eeeeffff00001111"],
    });
  });

  it("sends the text of the rules the shared findings name, redacted and cut, only with the findings", () => {
    const rule = (id: string, text: string) => ({ id, path: ["**"], rule: text });
    const ruled = reviewReport({
      findings: [
        finding({ rule: { kind: "rule", id: "tenant-scope" } }),
        finding({ fingerprint: "1111222233334444", rule: { kind: "rule", id: "long-rule" } }),
        finding({
          fingerprint: "5555666677778888",
          rule: { kind: "learning", id: "retry-budget" },
        }),
      ],
      provenance: {
        ocraVersion: "0.0.0",
        promptHash: "p",
        configHash: "c",
        sampling: {},
        rules: [
          rule(
            "tenant-scope",
            "Scope queries by tenant, never with api_key=sk-live-0123456789abcdef.",
          ),
          rule("long-rule", "x".repeat(MAX_RULE_TEXT + 500)),
          rule("unnamed", "No finding applies this one."),
          rule("retry-budget", "A rule that shares a learning's id."),
        ],
      },
    });
    expect(cloudUpload(ruled, cloud(false), pull).upload).not.toHaveProperty("provenance");
    const rules = cloudUpload(ruled, cloud(true), pull).upload.provenance?.rules ?? {};
    expect(Object.keys(rules).sort()).toEqual(["long-rule", "tenant-scope"]);
    expect(rules["tenant-scope"]).toBe("Scope queries by tenant, never with api_key=[redacted].");
    expect(rules["long-rule"]).toHaveLength(MAX_RULE_TEXT);
  });

  it("sends no rule text when no shared finding names a rule", () => {
    expect(cloudUpload(report, cloud(true), pull).upload).not.toHaveProperty("provenance");
  });

  it("names the repository only when the configuration shares its name", () => {
    expect(cloudUpload(report, cloud(false), local).upload).not.toHaveProperty("repo");
    const named = cloudUpload(report, cloud(false), { ...local, shareRepoName: true }).upload;
    expect(named.repo).toEqual({ name: "octo/app", url: "https://github.com/octo/app" });
    const nested = { ...cloud(false), repository: "https://gitlab.com/group/sub/app" };
    expect(cloudUpload(report, nested, { ...pull, shareRepoName: true }).upload.repo).toEqual({
      name: "group/sub/app",
      url: "https://gitlab.com/group/sub/app",
    });
  });

  it("names no repository without a host, or whose address the redaction pass would change", () => {
    for (const repository of [
      "/home/me/app",
      "c:/work/app",
      "https://github.com/octo/ghp_0123456789abcdefghijklmnopqrstuvwxyz",
    ]) {
      const upload = cloudUpload(
        report,
        { ...cloud(false), repository },
        { ...local, shareRepoName: true },
      ).upload;
      expect(upload, repository).not.toHaveProperty("repo");
    }
  });
});
