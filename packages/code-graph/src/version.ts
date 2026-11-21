import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { allLanguages } from "./languages.js";

// Changes whenever a query or the grammars do, so no cached entry or graph
// outlives the parser that made it.
export const VERSION = createHash("sha256")
  .update(
    (createRequire(import.meta.url)("@vscode/tree-sitter-wasm/package.json") as { version: string })
      .version,
  )
  .update(JSON.stringify(allLanguages()))
  .digest("hex");
