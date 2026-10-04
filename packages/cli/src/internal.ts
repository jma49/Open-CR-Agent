// "@open-cr-agent/cli/internal": what ocra's own packages share beyond the
// public API (index.ts), such as the command with its dependencies
// injected. Not a contract: any release may change or remove any of it.

export type { ReviewDeps } from "./commands/review/deps.js";
export {
  type CliPlanOutput,
  cliPlanOutputSchema,
  planJsonSchema,
} from "./commands/review/plan-schema.js";
export { configJsonSchema } from "./config/schema.js";
export type { Output } from "./io/output.js";
export { run } from "./run.js";
