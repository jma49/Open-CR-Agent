import { describe, expect, it } from "vitest";
import { detectLanguage } from "./languages.js";
import { parseRepoRules } from "./repo-rules.js";
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

describe("resolveRules", () => {
  it("always includes general rules and adds each detected language once, sorted", () => {
    const rules = resolveRules(["b.py", "a.ts", "c.ts", "notes.md"], []);
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
});
