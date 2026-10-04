import type { Finding } from "@open-cr-agent/core";
import { describe, expect, it } from "vitest";
import { finding } from "./conformance.fakes.js";
import { inlineBody } from "./render.js";
import { githubSuggestion, gitlabSuggestion } from "./suggestion.js";

const A = "a".repeat(16);

function withFix(replacement: string, overrides: Partial<Finding> = {}): Finding {
  return finding(A, {
    lineRange: { start: 3, end: 5 },
    suggestion: "Count up to n.",
    fix: { startLine: 3, endLine: 5, replacement },
    ...overrides,
  });
}

// The suggestion block is the comment's last part, after a blank line.
function block(body: string): string | undefined {
  const last = body.split("\n\n").at(-1) as string;
  return /^`{3,}suggestion/.test(last) ? last : undefined;
}

describe("committable suggestions", () => {
  it("puts GitHub's suggestion block under the explanation", () => {
    const body = inlineBody(withFix("for (let i = 0; i <= n; i++) {"), githubSuggestion);
    expect(body).toMatch(
      /\*\*Suggestion:\*\* Count up to n\.\n\n```suggestion\nfor \(let i = 0; i <= n; i\+\+\) \{\n```$/,
    );
  });

  it("reaches GitLab's thread on the last line back to the first", () => {
    expect(block(inlineBody(withFix("x();\ny();"), gitlabSuggestion))).toBe(
      "```suggestion:-2+0\nx();\ny();\n```",
    );
    const oneLine = withFix("x();", {
      lineRange: { start: 4, end: 4 },
      fix: { startLine: 4, endLine: 4, replacement: "x();" },
    });
    expect(block(inlineBody(oneLine, gitlabSuggestion))).toBe("```suggestion:-0+0\nx();\n```");
    const far = withFix("x();", {
      lineRange: { start: 1, end: 102 },
      fix: { startLine: 1, endLine: 102, replacement: "x();" },
    });
    expect(block(inlineBody(far, gitlabSuggestion))).toBeUndefined();
    expect(block(inlineBody(far, githubSuggestion))).toBeDefined();
  });

  it("deletes the lines with an empty replacement", () => {
    expect(block(inlineBody(withFix(""), githubSuggestion))).toBe("```suggestion\n```");
  });

  it("offers none unless the comment is on exactly the fixed lines in the diff", () => {
    const { lineRange: _, ...fileLevel } = withFix("x();", {
      anchor: { method: "file_level", inDiff: false },
    });
    const cases: Finding[] = [
      withFix("x();", { fix: { startLine: 3, endLine: 4, replacement: "x();" } }),
      withFix("x();", { fix: { startLine: 2, endLine: 5, replacement: "x();" } }),
      withFix("x();", { anchor: { method: "file", inDiff: false } }),
      fileLevel,
    ];
    for (const finding of cases) {
      for (const fence of [githubSuggestion, gitlabSuggestion]) {
        expect(block(inlineBody(finding, fence))).toBeUndefined();
      }
    }
    expect(block(inlineBody(finding(A), githubSuggestion))).toBeUndefined();
  });

  it("keeps a replacement with fences inside its own, longer fence, as written", () => {
    const replacement = "Example:\n```\n````\n``` suggestion\n~~~\nend";
    for (const fence of [githubSuggestion, gitlabSuggestion]) {
      const posted = block(inlineBody(withFix(replacement), fence)) as string;
      const lines = posted.split("\n");
      const ticks = (lines[0] as string).match(/^`+/)?.[0] as string;
      expect(ticks).toBe("`````");
      expect(lines.at(-1)).toBe(ticks);
      expect(lines.slice(1, -1).join("\n")).toBe(replacement);
      // No line inside could close the fence (CommonMark: as long or longer).
      for (const line of lines.slice(1, -1)) {
        expect(line.match(/^ {0,3}(`+)\s*$/)?.[1]?.length ?? 0).toBeLessThan(ticks.length);
      }
    }
  });

  it("offers none when a fence the model left open would swallow it", () => {
    const fenced = withFix("x();", { body: "Look:\n~~~\nopen", suggestion: "x\n  ~~~~ y" });
    expect(block(inlineBody(fenced, githubSuggestion))).toBeUndefined();
    // safeMarkdown escapes a backtick fence left open, so it opens nothing.
    const openBackticks = withFix("x();", { body: "Look:\n```\nopen" });
    expect(block(inlineBody(openBackticks, githubSuggestion))).toBe("```suggestion\nx();\n```");
  });

  it("posts code that would be markup outside a code block as written", () => {
    const replacement = 'notify("@here", "[x](https://evil.example)", "<img src=x>");';
    expect(block(inlineBody(withFix(replacement), githubSuggestion))).toBe(
      `\`\`\`suggestion\n${replacement}\n\`\`\``,
    );
  });

  it("offers none rather than change a replacement ocra would have to rewrite", () => {
    const refused = [
      "<!-- ocra:finding bbbbbbbbbbbbbbbb -->",
      "x();\n/ocra dismiss",
      "/OCRA override",
      "x();\r\ny();",
      "if (a) {‮} // admin",
      "\u001b[31mred",
      "x".repeat(20_001),
    ];
    for (const replacement of refused) {
      const body = inlineBody(withFix(replacement), githubSuggestion);
      expect(block(body)).toBeUndefined();
      expect(body).toContain("**Suggestion:** Count up to n.");
    }
  });
});
