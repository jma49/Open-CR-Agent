import type { ReviewReport } from "@open-cr-agent/core";
import { describe, expect, it } from "vitest";
import { finding, HEAD, report } from "./conformance.fakes.js";
import { inlineBody, renderSummary } from "./render.js";

const gitlab = { changeRequest: "merge request", authority: "the Developer role or higher" };

describe("renderSummary", () => {
  it("words the override and what is left for the platform", () => {
    const blocking: ReviewReport = {
      ...report([finding("a".repeat(16), { severity: "critical", verification: "confirmed" })]),
      verdict: "significant_concerns",
      coverage: [{ path: "src/other.ts", status: "unreviewed" }],
    };
    const body = renderSummary({
      report: blocking,
      commented: new Set(),
      state: { findings: [] },
      text: gitlab,
    });
    expect(body).toContain(
      `Someone with the Developer role or higher other than the author can let this commit pass by commenting \`/ocra override ${HEAD} <reason>\`.`,
    );
    expect(body).toContain("the next review of this merge request includes them");
  });

  it("names which memory hid findings, the repository's or the reviewing account's", () => {
    const entry = { file: "src/a.ts", title: "t", reason: "r" };
    const body = renderSummary({
      report: {
        ...report([]),
        remembered: [
          { ...entry, fingerprint: "c".repeat(16), source: "repository" },
          { ...entry, fingerprint: "d".repeat(16), source: "account" },
          { ...entry, fingerprint: "e".repeat(16), source: "account" },
        ],
      },
      commented: new Set(),
      state: { findings: [] },
      text: gitlab,
    });
    expect(body).toContain("1 finding(s) matched `.ocra/memory.json` and are not repeated.");
    expect(body).toContain(
      "2 finding(s) matched the reviewing account's ocra Cloud memory and are not repeated.",
    );
  });
});

describe("inlineBody", () => {
  it("neutralizes commands in every part a model wrote", () => {
    const body = inlineBody(
      finding("b".repeat(16), { title: "/close", body: "/merge", suggestion: "x\n/approve" }),
    );
    expect(body).not.toMatch(/^[ \t]*\//m);
  });
});
