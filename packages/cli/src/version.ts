import { createRequire } from "node:module";

// src/ and dist/ both sit one level below the package root.
export const VERSION: string = createRequire(import.meta.url)("../package.json").version;
