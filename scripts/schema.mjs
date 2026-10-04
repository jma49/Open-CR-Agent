// Writes the JSON Schemas of the review report (docs/schema/report.v1.json),
// from the Zod schema in @open-cr-agent/core, and of .ocra/config.json
// (docs/schema/config.v1.json) and the --plan JSON (docs/schema/plan.v1.json),
// from the CLI's. Run after a build; tests
// fail when a file and its schema differ.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { REPORT_VERSION, reportJsonSchema } from "@open-cr-agent/core";
import { PLAN_VERSION } from "@open-cr-agent/core/internal";
import { planJsonSchema } from "../packages/cli/dist/commands/review/plan-schema.js";
import { configJsonSchema } from "../packages/cli/dist/config/schema.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
for (const [name, schema] of [
  [`report.v${REPORT_VERSION}.json`, reportJsonSchema()],
  ["config.v1.json", configJsonSchema()],
  [`plan.v${PLAN_VERSION}.json`, planJsonSchema()],
]) {
  const target = join(root, "docs", "schema", name);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(schema, null, 2)}\n`);
  console.log(`wrote ${target}`);
}
