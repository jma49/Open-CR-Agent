import type { ReviewReport } from "@open-cr-agent/core";
import { describe, expect, it } from "vitest";
import { finding, HEAD, report } from "./conformance.fakes.js";
import { inlineBody, renderSummary, safeMarkdown } from "./render.js";

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
});

describe("safeMarkdown", () => {
  it.each(["/approve", "/merge", "/close", "/label ~bug", "  /unapprove", "\t/assign @me"])(
    "keeps %j from starting a line, where GitLab would run it",
    (command) => {
      const safe = safeMarkdown(`Looks fine.\n${command}\nMore.`);
      expect(safe).not.toMatch(/^[ \t]*\//m);
      expect(safe.replaceAll("​", "")).toBe(`Looks fine.\n${command}\nMore.`);
    },
  );

  it("leaves slashes inside a line alone", () => {
    expect(safeMarkdown("Read src/a.ts and a/b")).toBe("Read src/a.ts and a/b");
  });

  it("keeps every @ from mentioning anyone", () => {
    const safe = safeMarkdown("Ask @_alice, @.bob, @all or @here, or mail a@b.example");
    // A mention needs a name right after the @; none has one.
    expect(safe).not.toMatch(/@[^\u200b]/);
    expect(safe.replaceAll("\u200b", "")).toBe(
      "Ask @_alice, @.bob, @all or @here, or mail a@b.example",
    );
  });

  it("shows character references as typed, since mentions are found after decoding", () => {
    // GitHub rendered each of the first three as a mention of the user.
    const safe = safeMarkdown("&#64;alice &#x40;all &commat;here &amp; a && b");
    expect(safe).toBe("&\u200b#64;alice &\u200b#x40;all &\u200bcommat;here &\u200bamp; a && b");
  });

  it.each([
    "https://evil.example/fix",
    "HTTP://evil.example",
    "ftp://evil.example",
    "smb://evil.example/share",
    "vscode://evil.example/open",
    "ssh://git@evil.example/r",
  ])("keeps %s from becoming a link on either platform", (address) => {
    const safe = safeMarkdown(`See ${address} and <${address}>.`);
    // GitHub and GitLab both autolink at "://", GitLab for any scheme.
    expect(safe).not.toContain("://");
    expect(safe.replaceAll("\u200b", "")).toContain(address);
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
