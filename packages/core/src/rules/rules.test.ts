import { describe, expect, it } from "vitest";
import { CORRECTNESS_RULES } from "./builtin/index.js";
import { detectLanguage } from "./languages.js";
import { parseMarkdownRules, parseRepoRules } from "./repo-rules.js";
import { resolveRepoRules, resolveRules } from "./resolve.js";
import { identifyRules } from "./rule-ids.js";

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
      { id: "retries", path: billing, rule: "### Retries\nWrites carry an idempotency key." },
      { id: "severity", path: "**", rule: "## Severity\nA missing log line is a suggestion." },
    ]);
    const identified = identifyRules(rules);
    expect(resolveRepoRules(["services/billing/charge.ts"], identified).text).toContain(
      "Rule retries:\n### Retries\nWrites carry an idempotency key.",
    );
    expect(resolveRepoRules(["web/app.ts"], identified).ids).toEqual([
      identified[0]?.id,
      "severity",
    ]);
  });

  it("leaves out headings without text and refuses a file over the limit", () => {
    expect(parseMarkdownRules("# Review rules\n\n## web/\n")).toEqual([]);
    expect(() => parseMarkdownRules("x".repeat(20_001))).toThrow(".ocra/rules.md is longer than");
  });
});

describe("resolveRules", () => {
  it("always includes general rules and adds each detected language once, sorted", () => {
    const rules = resolveRules(["b.py", "a.ts", "c.ts", "notes.md"], CORRECTNESS_RULES);
    expect(rules).toContain("### General correctness");
    expect(rules.indexOf("### Python")).toBeGreaterThan(-1);
    expect(rules.indexOf("### Python")).toBeLessThan(rules.indexOf("### TypeScript"));
    expect(rules.match(/### TypeScript/g)).toHaveLength(1);
    expect(rules).not.toContain("### Go");
  });

  it("uses only the reviewer's own built-in rules", () => {
    expect(resolveRules(["a.ts"])).toBe("");
    const rules = resolveRules(["a.ts", "b.go"], {
      general: "### Security\n- x",
      languages: { go: "### Go security\n- y" },
    });
    expect(rules).toBe("### Security\n- x\n\n### Go security\n- y");
  });
});

describe("resolveRepoRules", () => {
  it("gives only the rules whose globs match a bundle file, each under its id", () => {
    const rules = identifyRules([
      { id: "tenant", path: "api/**", rule: "API handlers must check tenant ownership." },
      { path: ["web/**"], rule: "Web rule." },
    ]);
    expect(resolveRepoRules(["api/users.ts"], rules)).toEqual({
      text: "### Repository rules\nRule tenant:\nAPI handlers must check tenant ownership.",
      ids: ["tenant"],
    });
    expect(resolveRepoRules(["docs/a.md"], rules)).toEqual({ text: "", ids: [] });
  });
});

describe("identifyRules", () => {
  it("names a rule without an id by its text, and numbers a repeated id", () => {
    const rules = identifyRules([
      { path: "**", rule: "Log every retry." },
      { path: "api/**", rule: " Log every retry.\n" },
      { id: "auth", path: "**", rule: "a" },
      { id: "auth", path: "**", rule: "b" },
    ]);
    expect(rules.map((r) => r.id)).toEqual([
      expect.stringMatching(/^rule-[0-9a-f]{8}$/),
      `${rules[0]?.id}-2`,
      "auth",
      "auth-2",
    ]);
    expect(identifyRules([{ path: "x", rule: "Log every retry." }])[0]?.id).toBe(rules[0]?.id);
  });

  it("takes no id from a heading without latin letters or digits", () => {
    expect(parseMarkdownRules("## \u5ba1\u67e5\nx")).toEqual([
      { path: "**", rule: "## \u5ba1\u67e5\nx" },
    ]);
  });
});
