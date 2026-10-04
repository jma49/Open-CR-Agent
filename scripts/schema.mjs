// Writes the JSON Schemas of the review report (docs/schema/report.v1.json),
// from the Zod schema in @open-cr-agent/core, and of .ocra/config.json
// (docs/schema/config.v1.json), from the CLI's. Run after a build; tests
// fail when a file and its schema differ.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { REPORT_VERSION, reportJsonSchema } from "@open-cr-agent/core";
import { configJsonSchema } from "../packages/cli/dist/review/config.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
for (const [name, schema] of [
  [`report.v${REPORT_VERSION}.json`, reportJsonSchema()],
  ["config.v1.json", configJsonSchema()],
]) {
  const target = join(root, "docs", "schema", name);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(schema, null, 2)}\n`);
  console.log(`wrote ${target}`);
}
