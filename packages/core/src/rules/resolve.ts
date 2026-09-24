import picomatch from "picomatch";
import { GENERAL_RULES, LANGUAGE_RULES } from "./builtin/index.js";
import { detectLanguage, type Language } from "./languages.js";
import type { RepoRule } from "./repo-rules.js";

export function resolveRules(paths: readonly string[], repoRules: readonly RepoRule[]): string {
  const languages = new Set<Language>();
  for (const path of paths) {
    const language = detectLanguage(path);
    if (language) languages.add(language);
  }

  const sections = [GENERAL_RULES, ...[...languages].sort().map((l) => LANGUAGE_RULES[l])];
  const matching = repoRules.filter((r) => {
    const matches = picomatch(r.path, { dot: true });
    return paths.some((p) => matches(p));
  });
  if (matching.length > 0) {
    sections.push(`### Repository rules\n${matching.map((r) => r.rule.trim()).join("\n\n")}`);
  }
  return sections.join("\n\n");
}
