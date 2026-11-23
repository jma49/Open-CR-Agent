import { describe, expect, it } from "vitest";
import { CORRECTNESS_RULES } from "./builtin/index.js";
import { detectLanguage } from "./languages.js";
import { parseMarkdownRules, parseRepoRules } from "./repo-rules.js";
import { resolveRules } from "./resolve.js";

describe("detectLanguage", () => {
  it.each([
    ["src/a.tsx", "typescript"],
    ["lib/b.MJS", "typescript"],
    ["app/c.py", "python"],
    ["cmd/main.go", "go"],
    ["Main.java", "java"],
    ["README.md", undefined],
    [".py", undefined],
  ])("%s → %s", (path, language) => {
    expect(detectLanguage(path)).toBe(language);
  });
});

describe("parseRepoRules", () => {
  it("parses rules with single or multiple globs", () => {
    const rules = parseRepoRules(
      JSON.stringify({
        rules: [
          { path: "api/**", rule: "a" },
          { path: ["x", "y"], rule: "b" },
        ],
      }),
    );
    expect(rules).toHaveLength(2);
  });

  it("reports invalid JSON and invalid shapes", () => {
    expect(() => parseRepoRules("{")).toThrow(".ocra/rules.json is not valid JSON");
    expect(() => parseRepoRules('{"rules":[{"path":"a"}]}')).toThrow(".ocra/rules.json is invalid");
  });
});

describe("parseMarkdownRules", () => {
  it("scopes a section whose heading names a path, and its subsections, to that path", () => {
    const rules = parseMarkdownRules(
      [
        "Every finding names the input that breaks it.",
        "## services/billing/",
        "### Retries",
        "Writes carry an idempotency key.",
        "## Severity",
        "A missing log line is a suggestion.",
      ].join("\n"),
    );
    const billing = [
      "services/billing",
      "services/billing/**",
      "**/services/billing",
      "**/services/billing/**",
    ];
    expect(rules).toEqual([
      { path: "**", rule: "Every finding names the input that breaks it." },
      { path: billing, rule: "### Retries\nWrites carry an idempotency key." },
      { path: "**", rule: "## Severity\nA missing log line is a suggestion." },
    ]);
    expect(resolveRules(["services/billing/charge.ts"], rules)).toContain("idempotency key");
    expect(resolveRules(["web/app.ts"], rules)).not.toContain("idempotency key");
  });

  it("leaves out headings without text and refuses a file over the limit", () => {
    expect(parseMarkdownRules("# Review rules\n\n## web/\n")).toEqual([]);
    expect(() => parseMarkdownRules("x".repeat(20_001))).toThrow(".ocra/rules.md is longer than");
  });
});

describe("resolveRules", () => {
  it("always includes general rules and adds each detected language once, sorted", () => {
    const rules = resolveRules(["b.py", "a.ts", "c.ts", "notes.md"], [], CORRECTNESS_RULES);
    expect(rules).toContain("### General correctness");
    expect(rules.indexOf("### Python")).toBeGreaterThan(-1);
    expect(rules.indexOf("### Python")).toBeLessThan(rules.indexOf("### TypeScript"));
    expect(rules.match(/### TypeScript/g)).toHaveLength(1);
    expect(rules).not.toContain("### Go");
  });

  it("appends only repository rules whose globs match a bundle file", () => {
    const repoRules = [
      { path: "api/**", rule: "API handlers must check tenant ownership." },
      { path: ["web/**"], rule: "Web rule." },
    ];
    const rules = resolveRules(["api/users.ts"], repoRules);
    expect(rules).toContain("### Repository rules\nAPI handlers must check tenant ownership.");
    expect(rules).not.toContain("Web rule.");
  });

  it("uses only the reviewer's own built-in rules", () => {
    expect(resolveRules(["a.ts"], [])).toBe("");
    const rules = resolveRules(["a.ts", "b.go"], [], {
      general: "### Security\n- x",
      languages: { go: "### Go security\n- y" },
    });
    expect(rules).toBe("### Security\n- x\n\n### Go security\n- y");
  });
});
