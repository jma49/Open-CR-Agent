import type { Language } from "../languages.js";
import { GENERAL_RULES } from "./general.js";
import { GO_RULES } from "./go.js";
import { JAVA_RULES } from "./java.js";
import { PYTHON_RULES } from "./python.js";
import { TYPESCRIPT_RULES } from "./typescript.js";

export { GENERAL_RULES };

export const LANGUAGE_RULES: Record<Language, string> = {
  typescript: TYPESCRIPT_RULES,
  python: PYTHON_RULES,
  go: GO_RULES,
  java: JAVA_RULES,
};
