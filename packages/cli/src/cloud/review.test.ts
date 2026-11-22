import { priorFinding, reviewReport } from "@open-cr-agent/test-support";
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
});
