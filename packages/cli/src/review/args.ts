import { parseArgs } from "node:util";
import type { LocalTarget } from "@open-cr-agent/vcs-local";

export type OutputFormat = "text" | "json";

export interface ReviewArgs {
  target: LocalTarget;
  format: OutputFormat;
  output?: string;
  ignoreRepoConfig?: true;
}

export class UsageError extends Error {}

export const REVIEW_USAGE = `Usage: ocra review [options]

Reviews uncommitted changes by default.

Options:
  --from <ref>       Review changes on --to since it diverged from <ref>
  --to <ref>         End of the range (default: HEAD)
  --commit <sha>     Review a single commit
  --format <format>  text (default) or json
  --output <file>    Write the result to a file instead of stdout
  --no-repo-config   Ignore .ocra/config.json and its plugins (for untrusted
                     code); models come from OCRA_MODEL_* variables
  -h, --help         Show help
`;

export function parseReviewArgs(argv: string[]): ReviewArgs | "help" {
  let parsed: ReturnType<typeof parse>;
  try {
    parsed = parse(argv);
  } catch (error) {
    throw new UsageError((error as Error).message);
  }
  const { values, positionals } = parsed;
  if (values.help) return "help";
  if (positionals.length > 0) throw new UsageError(`Unexpected argument: ${positionals[0]}`);

  const format = values.format ?? "text";
  if (format !== "text" && format !== "json") {
    throw new UsageError(`--format must be text or json, got ${format}`);
  }

  const args: ReviewArgs = { target: target(values), format };
  if (values.output !== undefined) args.output = values.output;
  if (values["no-repo-config"]) args.ignoreRepoConfig = true;
  return args;
}

function parse(argv: string[]) {
  return parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    options: {
      from: { type: "string" },
      to: { type: "string" },
      commit: { type: "string" },
      format: { type: "string" },
      output: { type: "string" },
      "no-repo-config": { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
}

function target(values: { from?: string; to?: string; commit?: string }): LocalTarget {
  if (values.commit !== undefined) {
    if (values.from !== undefined || values.to !== undefined) {
      throw new UsageError("--commit cannot be combined with --from or --to");
    }
    return { mode: "commit", commit: values.commit };
  }
  if (values.from !== undefined)
    return { mode: "range", from: values.from, to: values.to ?? "HEAD" };
  if (values.to !== undefined) throw new UsageError("--to requires --from");
  return { mode: "workspace" };
}
