// Writes the README diagrams to docs/images after an architecture change:
// node scripts/diagrams.mjs. scripts/lib/diagrams.test.mjs fails until they
// are current.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { renderDiagrams } from "./lib/diagrams.mjs";

const out = join(import.meta.dirname, "..", "docs", "images");
for (const [name, svg] of renderDiagrams()) writeFileSync(join(out, name), svg);
