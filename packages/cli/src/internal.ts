// "@open-cr-agent/cli/internal": what ocra's own packages share beyond the
// public API (index.ts): the JSON Schemas of the plan and the configuration.
// Not a contract: any release may change or remove any of it.

export {
  type CliPlanOutput,
  cliPlanOutputSchema,
  planJsonSchema,
} from "./commands/review/plan-schema.js";
export { configJsonSchema } from "./config/schema.js";
