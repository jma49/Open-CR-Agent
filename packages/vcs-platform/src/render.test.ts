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
      `Someone with the Developer role or higher other than the author can let this commit pass by commenting \`@ocra override ${HEAD} <reason>\`.`,
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
          { path: "src/big.ts", status: "incomplete", ended: "context_window" },
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
    expect(body).toContain(
      "**Incomplete:** 1 selected file(s) were only partly reviewed: a reviewer filled its model's context window before it finished them. A smaller merge request, or a model with a larger window, leaves each file more room.",
    );
    expect(body).toContain("- partly reviewed (context window full): `src/big.ts`");
    expect(body).toContain("- partly reviewed (out of steps): `src/long.ts`");
    expect(body).toContain("- partly reviewed (stopped early): `src/odd.ts`");
    expect(body).toContain(
      "1 reviewed · 3 partly reviewed · 0 unchanged since the last review · 0 not reviewed",
    );
  });

  it("says a daily limit left files unreviewed", () => {
    const usage = {
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      cachedTokens: 0,
      costUsd: 0,
    };
    const body = renderSummary({
      report: {
        ...report([]),
        coverage: [
          { path: "src/ok.ts", status: "reviewed" },
          { path: "src/late.ts", status: "failed" },
        ],
        tasks: [
          {
            taskId: "t",
            reviewer: "logic",
            bundle: "b",
            files: ["src/late.ts"],
            status: "failed",
            quota: "daily_limit",
            findings: 0,
            durationMs: 0,
            usage,
          },
        ],
      },
      commented: new Set(),
      state: { findings: [] },
      text: gitlab,
    });
    expect(body).toContain(
      "**Incomplete:** 1 selected file(s) were not reviewed; the model provider refused calls because a daily limit was reached. They are listed",
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

describe("the walkthrough in the summary", () => {
  const walkthrough = {
    overview: "Adds retries. @all /merge",
    groups: [
      { title: "Retry `a|b`\n<!-- ocra:review -->", files: ["src/a`.ts"], note: "x\n/approve" },
      { title: "Tests", files: Array.from({ length: 12 }, (_, i) => `t${i}.ts`), note: "" },
    ],
    diagram: "sequenceDiagram\n  A->>B: call",
  };

  function summary(w: ReviewReport["walkthrough"]): string {
    return renderSummary({
      report: { ...report([]), ...(w ? { walkthrough: w } : {}) },
      commented: new Set(),
      state: { findings: [] },
      text: gitlab,
    });
  }

  it("neutralizes what the model wrote and keeps ocra's markers to ocra", () => {
    const body = summary(walkthrough);
    expect(problemsIn(body).filter((p) => /^(mention|command|carriage)/.test(p))).toEqual([]);
    expect(body.match(/<!-- ocra:review -->/g)).toHaveLength(1);
    expect(body).toContain("`src/aˋ.ts`");
  });

  it("folds the file groups, lists ten files of a group and counts the rest", () => {
    const body = summary(walkthrough);
    expect(body).toContain("<details><summary>Changes in 13 file(s)</summary>");
    expect(body).toContain("`t9.ts` and 2 more");
    expect(body).toContain("- **Tests**\n");
  });

  it("puts the diagram in a mermaid fence of its own", () => {
    expect(summary(walkthrough)).toContain("```mermaid\nsequenceDiagram\n  A->>B: call\n```");
    const { overview, groups } = walkthrough;
    expect(summary({ overview, groups })).not.toContain("mermaid");
    expect(summary(undefined)).not.toContain("### Walkthrough");
  });
});

describe("the pre-merge checks in the summary", () => {
  function summary(mergeChecks: ReviewReport["mergeChecks"]): string {
    return renderSummary({
      report: { ...report([]), ...(mergeChecks ? { mergeChecks } : {}) },
      commented: new Set(),
      state: { findings: [] },
      text: gitlab,
    });
  }

  it("lists each check's outcome and reason, neutralizing both", () => {
    const body = summary([
      {
        id: "a",
        instruction: "Say why @all",
        outcome: "failed",
        reason: "No why.\n/merge <!-- ocra:review -->",
      },
      { id: "b", instruction: "Add a test", outcome: "inconclusive", reason: "" },
    ]);
    expect(problemsIn(body).filter((p) => /^(mention|command|carriage)/.test(p))).toEqual([]);
    expect(body.match(/<!-- ocra:review -->/g)).toHaveLength(1);
    expect(body).toContain("### Pre-merge checks");
    expect(body).toContain("- **Failed**: Say why");
    expect(body).toContain("- **Inconclusive**: Add a test\n");
  });

  it("has no section when the review was given no checks", () => {
    expect(summary(undefined)).not.toContain("Pre-merge checks");
    expect(summary([])).not.toContain("Pre-merge checks");
  });
});

describe("findings outside the diff", () => {
  it("lists the title first and the finding's text on the next line", () => {
    const body = renderSummary({
      report: report([
        finding("a".repeat(16), {
          title: "Stale cache",
          body: "Keeps\nold rows.",
          preExisting: true,
        }),
      ]),
      commented: new Set(),
      state: { findings: [] },
      text: gitlab,
    });
    expect(body).toContain(
      "- 🟠 **Stale cache** · `src/login.ts:3` · not verified · pre-existing\\\n  Keeps old rows.",
    );
  });
});

describe("the coding agent that ran the review", () => {
  it("is named after ocra in the summary's heading and under each inline comment", () => {
    const byAgent: ReviewReport = { ...report([]), agent: "Codex" };
    const summary = renderSummary({
      report: byAgent,
      commented: new Set(),
      state: { findings: [] },
      text: gitlab,
    });
    expect(summary.split("\n")[1]).toMatch(/^## ocra · Codex review · /);
    const body = inlineBody(finding("c".repeat(16)), githubSuggestion, "Codex");
    expect(body.endsWith("\n\n<sub>ocra · Codex</sub>")).toBe(true);
  });

  it("is not named when ocra's own engine ran the review", () => {
    const summary = renderSummary({
      report: report([]),
      commented: new Set(),
      state: { findings: [] },
      text: gitlab,
    });
    expect(summary.split("\n")[1]).toMatch(/^## ocra review · /);
    expect(inlineBody(finding("c".repeat(16)), githubSuggestion)).not.toContain("<sub>");
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

  it("says when Verify traced the problem to code the change did not bring in", () => {
    const header = (preExisting: boolean) =>
      inlineBody(
        finding("d".repeat(16), preExisting ? { preExisting: true } : {}),
        githubSuggestion,
      ).split("\n")[2];
    expect(header(true)).toMatch(/ · pre-existing$/);
    expect(header(false)).not.toContain("pre-existing");
  });

  it("gives the title its own line, with the severity and notes under it", () => {
    const lines = inlineBody(
      finding("e".repeat(16), { title: "Retry count can go negative", severity: "critical" }),
      githubSuggestion,
    ).split("\n");
    expect(lines[1]).toBe("🔴 **Retry count can go negative**\\");
    expect(lines[2]).toMatch(/^Critical · \S+ · not verified$/);
    expect(lines[3]).toBe("");
  });

  it("folds the facts behind a finding under it, each on its own line", () => {
    const body = inlineBody(
      finding("f".repeat(16), {
        evidence: ["caller passes null\n/close", " ", ...Array(6).fill("x".repeat(400))],
      }),
      githubSuggestion,
    );
    const folded = body.slice(body.indexOf("<details><summary>Evidence</summary>"));
    const facts = folded.split("\n").filter((line) => line.startsWith("- "));
    expect(facts).toHaveLength(5);
    expect(facts[0]).toContain("caller passes null");
    expect(facts[1]).toHaveLength(2 + 300);
    expect(folded).not.toMatch(/^[ \t]*\//m);
    expect(folded.endsWith("\n\n</details>")).toBe(true);
  });

  it("has no evidence section for a finding without evidence", () => {
    expect(inlineBody(finding("a".repeat(16)), githubSuggestion)).not.toContain("<details>");
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
