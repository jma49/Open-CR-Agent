// Writes the JSON Schema of the review report (docs/schema/report.v1.json)
// from the Zod schema in @open-cr-agent/core. Run after a build; a test
// fails when the file and the schema differ.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { REPORT_VERSION, reportJsonSchema } from "@open-cr-agent/core";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const target = join(root, "docs", "schema", `report.v${REPORT_VERSION}.json`);
mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, `${JSON.stringify(reportJsonSchema(), null, 2)}\n`);
console.log(`wrote ${target}`);
