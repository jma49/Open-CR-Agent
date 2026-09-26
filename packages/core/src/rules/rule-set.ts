import type { Language } from "./languages.js";

// Built-in review guidance a reviewer brings: general rules plus rules for
// the languages present in the bundle.
export interface RuleSet {
  general?: string;
  languages?: Partial<Record<Language, string>>;
}
