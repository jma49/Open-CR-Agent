import type { ReviewReport } from "@open-cr-agent/core";
import { describe, expect, it } from "vitest";
import { finding, HEAD, report } from "./conformance.fakes.js";
import { problemsIn } from "./markdown.fakes.js";
import { inlineBody, renderSummary } from "./render.js";
import { githubSuggestion } from "./suggestion.js";

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

  it("names the files a reviewer only partly reviewed, and says why and what to do (#477)", () => {
    const body = renderSummary({
      report: {
        ...report([]),
        coverage: [
          { path: "src/long.ts", status: "incomplete", ended: "step_cap" },
          { path: "src/odd.ts", status: "incomplete", ended: "stopped_early" },
          { path: "src/ok.ts", status: "reviewed" },
        ],
      },
      commented: new Set(),
      state: { findings: [] },
      text: gitlab,
    });
    expect(body).toContain(" · incomplete");
    expect(body).toContain(
      "**Incomplete:** 1 selected file(s) were only partly reviewed: a reviewer used all 30 of its steps before it finished them. The step limit is fixed; a smaller merge request gives each file more of them.",
    );
    expect(body).toContain(
      "**Incomplete:** 1 selected file(s) were only partly reviewed: a reviewer stopped with steps left, without saying it had finished them.",
    );
    expect(body).toContain("- partly reviewed (out of steps): `src/long.ts`");
    expect(body).toContain("- partly reviewed (stopped early): `src/odd.ts`");
    expect(body).toContain(
      "1 reviewed · 2 partly reviewed · 0 unchanged since the last review · 0 not reviewed",
    );
  });

  it("names which memory hid findings, the repository's or the reviewing account's, and only those", () => {
    const entry = { file: "src/a.ts", title: "t", reason: "r" };
    const body = renderSummary({
      report: {
        ...report([]),
        remembered: [
          { ...entry, fingerprint: "c".repeat(16), source: "repository" },
          { ...entry, fingerprint: "d".repeat(16), source: "account" },
          { ...entry, fingerprint: "e".repeat(16), source: "account" },
          // As a report written before entries had a source has it.
          { ...entry, fingerprint: "b".repeat(16) } as ReviewReport["remembered"][number],
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

  it("credits dismissals to maintainers, since reviewers are ocra's agents", () => {
    const prior = {
      fingerprint: "f".repeat(16),
      title: "t",
      file: "src/a.ts",
      severity: "warning" as const,
      commented: true,
    };
    const body = renderSummary({
      report: {
        ...report([]),
        rereview: {
          fixed: [],
          notReproduced: [{ ...prior, fingerprint: "e".repeat(16) }],
          notRechecked: [],
          unchanged: [],
          dismissed: [prior],
        },
      },
      commented: new Set(),
      state: { findings: [] },
      text: gitlab,
    });
    expect(body).toContain("### Dismissed by maintainers");
    expect(body).toContain("until the code changes or a maintainer dismisses them.");
    expect(body).not.toContain("reviewer dismisses");
  });

  it("keeps a title and a body on their line of a list, which a line break would continue", () => {
    // Continued in the list item, the title's second line makes its first a
    // table header, whose cell boundary splits the code span.
    const title = "t `a|@all`\n    |-|-|\nx";
    const body = renderSummary({
      report: report([finding("a".repeat(16), { title, body: "b\r/merge" })]),
      commented: new Set(),
      state: { findings: [] },
      text: gitlab,
    });
    expect(problemsIn(body).filter((p) => /^(mention|command|carriage)/.test(p))).toEqual([]);
    expect(body).toContain("**t `a|@all`     |-|-| x**");
  });
});

describe("inlineBody", () => {
  it("neutralizes commands in every part a model wrote", () => {
    const body = inlineBody(
      finding("b".repeat(16), { title: "/close", body: "/merge", suggestion: "x\n/approve" }),
      githubSuggestion,
    );
    expect(body).not.toMatch(/^[ \t]*\//m);
  });

  it("posts a suggestion only from ocra's own block, not from the model's text", () => {
    const fix = { startLine: 3, endLine: 3, replacement: "y" };
    const body = inlineBody(
      finding("c".repeat(16), { body: "Do:\n```suggestion\nevil\n```", fix }),
      githubSuggestion,
    );
    expect(body.match(/^`{3,}suggestion$/gm)).toEqual(["```suggestion"]);
    expect(body.endsWith("```suggestion\ny\n```")).toBe(true);
  });
});
