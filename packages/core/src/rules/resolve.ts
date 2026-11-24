import picomatch from "picomatch";
import { detectLanguage, type Language } from "./languages.js";
import type { IdentifiedRule } from "./rule-ids.js";
import type { RuleSet } from "./rule-set.js";

// The reviewer's own rules: general ones plus those of the bundle's languages.
export function resolveRules(paths: readonly string[], builtin: RuleSet = {}): string {
  const languages = new Set<Language>();
  for (const path of paths) {
    const language = detectLanguage(path);
    if (language) languages.add(language);
  }
  const sections: string[] = [];
  if (builtin.general) sections.push(builtin.general);
  for (const language of [...languages].sort()) {
    const rules = builtin.languages?.[language];
    if (rules) sections.push(rules);
  }
  return sections.join("\n\n");
}

export interface MatchedRules {
  text: string;
  ids: string[];
}

// The repository's rules that match a bundle file, each under its id so a
// finding can name the one it applies.
export function resolveRepoRules(
  paths: readonly string[],
  rules: readonly IdentifiedRule[],
): MatchedRules {
  const matching = rules.filter((r) => {
    const matches = picomatch(r.path, { dot: true });
    return paths.some((p) => matches(p));
  });
  if (matching.length === 0) return { text: "", ids: [] };
  return {
    text: `### Repository rules\n${matching.map((r) => `Rule ${r.id}:\n${r.rule.trim()}`).join("\n\n")}`,
    ids: matching.map((r) => r.id),
  };
}
