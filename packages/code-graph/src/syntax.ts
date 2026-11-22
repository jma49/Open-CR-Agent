import type { SyntaxChecker } from "@open-cr-agent/core";
import { MAX_FILE_CHARS } from "./extractor.js";
import { languageOf } from "./languages.js";
import { parseErrors } from "./parse.js";

export function treeSitterSyntax(): SyntaxChecker {
  return {
    errors(path, content) {
      const spec = languageOf(path);
      if (!spec || content.length > MAX_FILE_CHARS) return Promise.resolve(undefined);
      return parseErrors(spec, content);
    },
  };
}
