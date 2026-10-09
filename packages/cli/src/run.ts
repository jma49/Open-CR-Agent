import { parseArgs } from "node:util";
import { errorMessage, isOcraError } from "@open-cr-agent/core";
import { defaultCloudDeps } from "./cloud/deps.js";
import { INIT_USAGE, initCommand } from "./commands/init.js";
import { LOGIN_USAGE, loginCommand } from "./commands/login.js";
import { memoryCommand } from "./commands/memory.js";
import { metricsCommand } from "./commands/metrics.js";
import { PLUGINS_USAGE, pluginsCommand } from "./commands/plugins.js";
import { parseReviewArgs, REVIEW_USAGE } from "./commands/review/args.js";
import type { ReviewDeps } from "./commands/review/deps.js";
import { BUILTIN_RUNTIMES } from "./commands/review/runtimes.js";
import { BUILTIN_PLUGINS, reviewCommand } from "./commands/review.js";
import { EXIT } from "./io/exit.js";
import type { Output } from "./io/output.js";
import { forTerminal } from "./io/terminal.js";
import { UsageError } from "./io/usage-error.js";
import { defaultNpm } from "./plugins/npm.js";
import { pluginsDir } from "./plugins/store.js";
import { sessionKey } from "./session/key.js";
import { VERSION } from "./version.js";

const USAGE = `Usage: ocra <command> [options]

Commands:
  init        Set up ocra for this repository, and its GitHub workflow with --github
  review      Review code changes (run "ocra review --help" for options)
  memory      Remember findings the team accepts (run "ocra memory --help")
  metrics     Counts over past reviews: runs, cost, findings, per reviewer (run "ocra metrics --help")
  plugins     Allow plugins your ocra Cloud settings name on this machine (run "ocra plugins --help")
  login       Sign in to ocra Cloud (in development; run "ocra login --help")
  logout      Sign out of ocra Cloud
  whoami      Show the ocra Cloud account

Options:
  -h, --help     Show help
  -v, --version  Show version
`;

export function defaultDeps(): ReviewDeps {
  return {
    cwd: process.cwd(),
    env: process.env,
    builtinPlugins: BUILTIN_PLUGINS,
    runtimes: BUILTIN_RUNTIMES,
    cloud: defaultCloudDeps(process.env),
    sessionKey: () => sessionKey(process.env),
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
  if (command === "init") {
    try {
      return await initCommand(rest, out, { cwd: deps.cwd, env: deps.env });
    } catch (error) {
      if (error instanceof UsageError) err.write(`${error.message}\n\n${INIT_USAGE}`);
      else err.write(failure(error));
      return EXIT.error;
    }
  }
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
  if (command === "plugins") {
    try {
      return await pluginsCommand(rest, out, {
        dir: pluginsDir(deps.env),
        npm: deps.npm ?? defaultNpm(),
      });
    } catch (error) {
      if (error instanceof UsageError) {
        err.write(`${error.message ? `${error.message}\n\n` : ""}${PLUGINS_USAGE}`);
      } else err.write(failure(error));
      return EXIT.error;
    }
  }
  if (command === "login" || command === "logout" || command === "whoami") {
    try {
      return await loginCommand(command, rest, out, err, defaultCloudDeps(deps.env));
    } catch (error) {
      if (error instanceof UsageError) err.write(`${error.message}\n\n${LOGIN_USAGE}`);
      else err.write(failure(error));
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
