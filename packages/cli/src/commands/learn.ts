import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { OcraError } from "@open-cr-agent/core";
import { learningDrafter } from "@open-cr-agent/core/internal";
import { EXIT } from "../io/exit.js";
import { forTerminal } from "../io/terminal.js";
import { UsageError } from "../io/usage-error.js";
import { acceptedFindingCandidates } from "./learn/accepted-findings.js";
import { documentCandidates } from "./learn/documents.js";
import { fixCandidates } from "./learn/fix-commits.js";
import { type LearnResult, learnFrom } from "./learn/pipeline.js";
import { proposeLearnings } from "./learn/propose.js";
import { learningFile, writeLearning } from "./learn/write.js";
import type { ReviewArgs } from "./review/args.js";
import type { ReviewDeps } from "./review/deps.js";
import { startRuntime } from "./review/execute-run.js";
import { type ResolvedRun, type ReviewIo, resolveRun } from "./review/resolve-run.js";

const DEFAULT_MAX = 20;
const CONCURRENCY = 4;

export const LEARN_USAGE = `Usage: ocra learn <mine|feedback|import <file.md>...> [options]

Drafts learnings for .ocra/learnings/, one helper model call each:
  mine        from the fix commits on HEAD's first-parent line, newest first
  feedback    from the findings the team accepted in .ocra/memory.json,
              with the reason it gave, newest first
  import      from each ## section of the Markdown files named that names
              files of the repository

A draft is kept when it is not a duplicate and the selection gives it to
the change or file it came from. Kept learnings are written to the working
tree, to commit or discard, or with --propose opened as a GitHub pull
request that merges once its checks pass (learnings.requireReview: true
leaves it to a person). What an existing learning records is skipped.

Options:
  --propose           Open a pull request with them instead (needs GITHUB_TOKEN)
  --max <n>           Drafts at most (default: ${DEFAULT_MAX})
  --max-cost-usd <n>  Spend limit (default: the configuration's maxCostUsd)
  -h, --help          Show help
`;

// Where each learn command finds its evidence (ADR-0040).
const SOURCES = {
  mine: { what: "fix commits", candidates: (run: ResolvedRun) => fixCandidates(run.root) },
  feedback: {
    what: "accepted findings",
    candidates: (run: ResolvedRun) => acceptedFindingCandidates(run.target.trusted),
  },
  import: {
    what: "documents",
    candidates: (run: ResolvedRun, documents: readonly string[]) =>
      documentCandidates(run.root, documents, run.target.trusted),
  },
} as const;
type Source = keyof typeof SOURCES;

interface LearnArgs {
  source: Source;
  documents: string[];
  max: number;
  propose: boolean;
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
    const result = await learnFrom(
      await SOURCES[args.source].candidates(
        run,
        args.documents.map((d) => resolve(deps.cwd, d)),
      ),
      {
        existing: run.learnings,
        max: args.max,
        concurrency: maxCostUsd === undefined ? CONCURRENCY : 1,
        draft,
        mayCall: () => maxCostUsd === undefined || spent < maxCostUsd,
        signal: run.interrupt.signal,
        warn: run.warn,
      },
    );
    const created = new Date(deps.now()).toISOString().slice(0, 10);
    if (args.propose && result.kept.length > 0) {
      const proposed = await proposeLearnings(
        run,
        result.kept,
        created,
        deps,
        SOURCES[args.source].what,
      );
      for (const warning of proposed.warnings) run.warn(warning);
      io.out.write(`${forTerminal(proposed.webUrl)}\n`);
      io.err.write(`[ocra] Pull request ${MERGE[proposed.merge]}\n`);
    } else {
      for (const kept of result.kept) {
        const text = learningFile(kept, created);
        io.out.write(`${forTerminal(await writeLearning(run.root, text, kept.title))}\n`);
      }
    }
    io.err.write(`[ocra] ${summary(result, spent)}\n`);
    return run.interrupt.signal.aborted ? EXIT.interrupted : EXIT.ok;
  } finally {
    stopListening?.();
    stopCloud();
    await runtime.dispose?.();
  }
}

const MERGE = {
  enabled: "opened; it merges once its checks pass",
  merged: "opened and merged: no check was required",
  off: "opened for review (learnings.requireReview)",
  unavailable: "opened; it waits for a person to merge it",
} as const;

function summary(result: LearnResult, spent: number): string {
  const parts = [
    `${result.kept.length} learning(s) kept from ${result.drafted} draft(s)`,
    result.declined > 0 ? `${result.declined} held no lesson` : "",
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
      propose: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) return "help";
  const [action, ...rest] = positionals;
  if (
    action === undefined ||
    !Object.hasOwn(SOURCES, action) ||
    (action !== "import" && rest.length > 0)
  ) {
    throw new UsageError(
      action === undefined ? "" : `Unknown learn command: ${positionals.join(" ")}`,
    );
  }
  const max = values.max === undefined ? DEFAULT_MAX : Number(values.max);
  if (!Number.isInteger(max) || max < 1) {
    throw new UsageError(`--max must be a positive whole number, got ${values.max}`);
  }
  const propose = values.propose === true;
  const cost = values["max-cost-usd"];
  if (cost === undefined) return { source: action as Source, documents: rest, max, propose };
  const maxCostUsd = Number(cost);
  if (!(maxCostUsd > 0)) {
    throw new UsageError(`--max-cost-usd must be a positive number, got ${cost}`);
  }
  return { source: action as Source, documents: rest, max, propose, maxCostUsd };
}
