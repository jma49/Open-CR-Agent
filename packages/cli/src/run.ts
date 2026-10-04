import { writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { errorMessage, isOcraError } from "@open-cr-agent/core";
import { memoryCommand } from "./memory.js";
import { metricsCommand } from "./metrics.js";
import { parseReviewArgs, REVIEW_USAGE, UsageError } from "./review/args.js";
import { BUILTIN_PLUGINS, EXIT, type ReviewDeps, reviewCommand } from "./review/command.js";
import type { Output } from "./review/progress.js";
import { forTerminal } from "./review/terminal.js";
import { VERSION } from "./version.js";

const USAGE = `Usage: ocra <command> [options]

Commands:
  review      Review code changes (run "ocra review --help" for options)
  memory      Remember findings the team accepts (run "ocra memory --help")
  metrics     Counts over past reviews: runs, cost, findings, per reviewer (run "ocra metrics --help")

Options:
  -h, --help     Show help
  -v, --version  Show version
`;

export function defaultDeps(): ReviewDeps {
  return {
    cwd: process.cwd(),
    env: process.env,
    builtinPlugins: BUILTIN_PLUGINS,
    writeFile: (path, content) => writeFile(path, content, "utf8"),
    now: Date.now,
    heartbeatMs: 30_000,
    onInterrupt(handler) {
      let signals = 0;
      const listener = () => {
        signals += 1;
        if (signals > 1) process.exit(EXIT.interrupted);
        handler();
      };
      process.on("SIGINT", listener);
      process.on("SIGTERM", listener);
      return () => {
        process.off("SIGINT", listener);
        process.off("SIGTERM", listener);
      };
    },
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
  if (command === "memory" || command === "metrics") {
    try {
      return command === "memory"
        ? await memoryCommand(rest, out, deps.cwd)
        : await metricsCommand(rest, out, deps.cwd);
    } catch (error) {
      err.write(failure(error));
      return EXIT.error;
    }
  }
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
      err.write(failure(error));
    }
    return EXIT.error;
  }
}

// The code is what a script may match on; the message is for people.
function failure(error: unknown): string {
  const code = isOcraError(error) ? ` [${error.code}]` : "";
  return `ocra${code}: ${forTerminal(errorMessage(error))}\n`;
}
