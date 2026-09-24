import { writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { errorMessage } from "@open-cr-agent/core";
import { OpenCodeRuntime } from "@open-cr-agent/runtime-opencode";
import { LocalGitAdapter } from "@open-cr-agent/vcs-local";
import { parseReviewArgs, REVIEW_USAGE, UsageError } from "./review/args.js";
import { EXIT, type ReviewDeps, reviewCommand } from "./review/command.js";
import type { Output } from "./review/progress.js";

export const VERSION = "0.0.0";

const USAGE = `Usage: ocra <command> [options]

Commands:
  review      Review code changes (run "ocra review --help" for options)

Options:
  -h, --help     Show help
  -v, --version  Show version
`;

export function defaultDeps(): ReviewDeps {
  return {
    cwd: process.cwd(),
    env: process.env,
    createVcs: (options) => new LocalGitAdapter(options),
    createRuntime: (config) => new OpenCodeRuntime({ models: config.models }),
    writeFile: (path, content) => writeFile(path, content, "utf8"),
    now: Date.now,
    heartbeatMs: 30_000,
  };
}

export async function run(
  argv: string[],
  out: Output,
  err: Output,
  deps: ReviewDeps = defaultDeps(),
): Promise<number> {
  const [command, ...rest] = argv;
  if (command === "review") return review(rest, out, err, deps);
  if (command !== undefined && !command.startsWith("-")) {
    err.write(`Unknown command: ${command}\n\n${USAGE}`);
    return EXIT.error;
  }

  let values: { help?: boolean; version?: boolean };
  try {
    values = parseArgs({
      args: argv,
      strict: true,
      options: { help: { type: "boolean", short: "h" }, version: { type: "boolean", short: "v" } },
    }).values;
  } catch (error) {
    err.write(`${errorMessage(error)}\n\n${USAGE}`);
    return EXIT.error;
  }
  if (values.version) {
    out.write(`${VERSION}\n`);
    return EXIT.ok;
  }
  out.write(USAGE);
  return EXIT.ok;
}

async function review(argv: string[], out: Output, err: Output, deps: ReviewDeps): Promise<number> {
  try {
    const args = parseReviewArgs(argv);
    if (args === "help") {
      out.write(REVIEW_USAGE);
      return EXIT.ok;
    }
    return await reviewCommand(args, { out, err }, deps);
  } catch (error) {
    if (error instanceof UsageError) {
      err.write(`${error.message}\n\n${REVIEW_USAGE}`);
    } else {
      err.write(`ocra: ${errorMessage(error)}\n`);
    }
    return EXIT.error;
  }
}
