import picomatch from "picomatch";
import { detectLanguage, type Language } from "./languages.js";
import type { RepoRule } from "./repo-rules.js";
import type { RuleSet } from "./rule-set.js";

export function resolveRules(
  paths: readonly string[],
  repoRules: readonly RepoRule[],
  builtin: RuleSet = {},
): string {
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
  const matching = repoRules.filter((r) => {
    const matches = picomatch(r.path, { dot: true });
    return paths.some((p) => matches(p));
  });
  if (matching.length > 0) {
    sections.push(`### Repository rules\n${matching.map((r) => r.rule.trim()).join("\n\n")}`);
  }
  return sections.join("\n\n");
}
