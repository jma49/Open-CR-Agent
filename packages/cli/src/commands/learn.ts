import { parseArgs } from "node:util";
import { OcraError } from "@open-cr-agent/core";
import { learningDrafter } from "@open-cr-agent/core/internal";
import { EXIT } from "../io/exit.js";
import { forTerminal } from "../io/terminal.js";
import { UsageError } from "../io/usage-error.js";
import { fixCandidates } from "./learn/fix-commits.js";
import { type LearnResult, learnFrom } from "./learn/pipeline.js";
import { learningFile, writeLearning } from "./learn/write.js";
import type { ReviewArgs } from "./review/args.js";
import type { ReviewDeps } from "./review/deps.js";
import { startRuntime } from "./review/execute-run.js";
import { type ReviewIo, resolveRun } from "./review/resolve-run.js";

const DEFAULT_MAX = 20;
const CONCURRENCY = 4;

export const LEARN_USAGE = `Usage: ocra learn mine [options]

Drafts learnings for .ocra/learnings/ from the fix commits on HEAD's
first-parent line, newest first: one helper model call per fix. A draft is
kept when it is not a duplicate and the selection gives it to the fix it
came from. Kept learnings are written to the working tree, to commit or
discard; fixes an existing learning records are skipped.

Options:
  --max <n>           Fixes to draft at most (default: ${DEFAULT_MAX})
  --max-cost-usd <n>  Spend limit (default: the configuration's maxCostUsd)
  -h, --help          Show help
`;

interface LearnArgs {
  max: number;
  maxCostUsd?: number;
}

export async function learnCommand(
  argv: string[],
  io: ReviewIo,
  deps: ReviewDeps,
): Promise<number> {
  const args = parseLearnArgs(argv);
  if (args === "help") {
    io.out.write(LEARN_USAGE);
    return EXIT.ok;
  }
  const reviewArgs: ReviewArgs = {
    target: { mode: "workspace" },
    format: "text",
    ...(args.maxCostUsd !== undefined ? { maxCostUsd: args.maxCostUsd } : {}),
  };
  const run = await resolveRun(reviewArgs, io, deps, { logged: false });
  const maxCostUsd = args.maxCostUsd ?? run.config.maxCostUsd;
  const { runtime, stopCloud } = await startRuntime(run, deps, {});
  const stopListening = deps.onInterrupt?.(() => run.interrupt.abort());
  let spent = 0;
  try {
    const draft = learningDrafter(runtime, (usage) => (spent += usage.costUsd), {
      effort: run.config.effort,
      roles: run.config.roles,
    });
    if (!draft) {
      throw new OcraError(
        "RUNTIME_START_FAILED",
        `the ${run.config.runtime} runtime makes no plain completions, which drafting needs`,
      );
    }
    const result = await learnFrom(await fixCandidates(run.root), {
      existing: run.learnings,
      max: args.max,
      concurrency: maxCostUsd === undefined ? CONCURRENCY : 1,
      draft,
      mayCall: () => maxCostUsd === undefined || spent < maxCostUsd,
      signal: run.interrupt.signal,
      warn: run.warn,
    });
    const created = new Date(deps.now()).toISOString().slice(0, 10);
    for (const kept of result.kept) {
      io.out.write(
        `${forTerminal(await writeLearning(run.root, learningFile(kept, created), kept.title))}\n`,
      );
    }
    io.err.write(`[ocra] ${summary(result, spent)}\n`);
    return run.interrupt.signal.aborted ? EXIT.interrupted : EXIT.ok;
  } finally {
    stopListening?.();
    stopCloud();
    await runtime.dispose?.();
  }
}

function summary(result: LearnResult, spent: number): string {
  const parts = [
    `${result.kept.length} learning(s) written from ${result.drafted} draft(s)`,
    result.declined > 0 ? `${result.declined} fix(es) held no lesson` : "",
    result.duplicates > 0 ? `${result.duplicates} duplicate(s)` : "",
    result.unselected > 0 ? `${result.unselected} the selection would not give to their fix` : "",
    result.failed > 0 ? `${result.failed} failed` : "",
    result.unaffordable > 0 ? `${result.unaffordable} left by the spend limit` : "",
    result.recorded > 0 ? `${result.recorded} already recorded` : "",
  ].filter((p) => p !== "");
  return `${parts.join(", ")}; $${spent.toFixed(4)}`;
}

function parseLearnArgs(argv: string[]): LearnArgs | "help" {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    options: {
      max: { type: "string" },
      "max-cost-usd": { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) return "help";
  const [action, ...rest] = positionals;
  if (action !== "mine" || rest.length > 0) {
    throw new UsageError(
      action === undefined ? "" : `Unknown learn command: ${positionals.join(" ")}`,
    );
  }
  const max = values.max === undefined ? DEFAULT_MAX : Number(values.max);
  if (!Number.isInteger(max) || max < 1) {
    throw new UsageError(`--max must be a positive whole number, got ${values.max}`);
  }
  const cost = values["max-cost-usd"];
  if (cost === undefined) return { max };
  const maxCostUsd = Number(cost);
  if (!(maxCostUsd > 0)) {
    throw new UsageError(`--max-cost-usd must be a positive number, got ${cost}`);
  }
  return { max, maxCostUsd };
}
