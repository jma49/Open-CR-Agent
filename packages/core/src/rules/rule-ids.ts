import { shortHash } from "../hash.js";
import type { SourcedRule } from "./repo-rules.js";

export type IdentifiedRule = SourcedRule & { id: string };

// A rule keeps the id it was given; one without is named by its text, so
// the id holds while the rule reads the same. Ids are unique in a review:
// a repeated one gets a number.
export function identifyRules(rules: readonly SourcedRule[]): IdentifiedRule[] {
  const seen = new Set<string>();
  return rules.map((rule) => {
    const base = rule.id ?? `rule-${shortHash(rule.rule.trim()).slice(0, 8)}`;
    let id = base;
    for (let n = 2; seen.has(id); n++) id = `${base.slice(0, 60)}-${n}`;
    seen.add(id);
    return { ...rule, id };
  });
}
