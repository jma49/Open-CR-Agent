import { resolve } from "node:path";
import { LEARNINGS_DIR } from "@open-cr-agent/cloud-contract";
import { OcraError } from "@open-cr-agent/core";
import { learningDrafter } from "@open-cr-agent/core/internal";
import { EXIT } from "../io/exit.js";
import { forTerminal } from "../io/terminal.js";
import { UsageError } from "../io/usage-error.js";
import { acceptedFindingCandidates, declinedFindingCandidates } from "./learn/accepted-findings.js";
import { DEFAULT_MAX, parseLearnArgs } from "./learn/args.js";
import { checkLearnings } from "./learn/check.js";
import { documentCandidates } from "./learn/documents.js";
import { fixCandidates } from "./learn/fix-commits.js";
import { type Candidate, type LearnResult, learnFrom } from "./learn/pipeline.js";
import { proposeLearnings } from "./learn/propose.js";
import { proposedLearnings } from "./learn/proposed.js";
import { rememberedCandidates } from "./learn/remembered.js";
import { learningFile, writeLearning } from "./learn/write.js";
import type { ReviewArgs } from "./review/args.js";
import type { ReviewDeps } from "./review/deps.js";
import { startRuntime } from "./review/execute-run.js";
import { type ResolvedRun, type ReviewIo, resolveRun } from "./review/resolve-run.js";

const CONCURRENCY = 4;

export const LEARN_USAGE = `Usage: ocra learn <mine|feedback|import <file.md>...|remember|check> [options]

Drafts learnings for .ocra/learnings/, one helper model call each:
  mine        from the fix commits on HEAD's first-parent line, newest first
  feedback    from the findings the team accepted in .ocra/memory.json,
              with the reason it gave, newest first; with --pr or --mr,
              also from the findings of its review that someone with write
              access declined in their thread, with what they said
  import      from each ## section of the Markdown files named that names
              files of the repository
  remember    from each "@ocra remember <note>" on --pr or --mr by someone
              with write access

  check       lists the learnings whose paths match no file at HEAD,
              which reviews no longer give by path; exits 1 when there are
              any. Makes no model call

A draft is kept when it is not a duplicate and the selection gives it to
the change or file it came from. Kept learnings are written to the working
tree, to commit or discard, or with --propose opened as a GitHub pull
request or GitLab merge request that merges once its checks pass
(learnings.requireReview: true or --require-review leaves it to a
person). What a learning already records, or one waiting on a proposal
branch of origin, is skipped.

Options:
  --propose           Open a pull or merge request with them instead
  --repo <owner/name> The GitHub repository: --pr's, or where --propose opens
                      it (needs GITHUB_TOKEN)
  --project <id|path> The GitLab project: --mr's, or where --propose opens
                      it (needs GITLAB_TOKEN)
  --require-review    With --propose: leave it for a person to merge
  --pr <n>, --mr <n>  With remember or feedback: the pull or merge request
                      it reads
  --max <n>           Drafts at most (default: ${DEFAULT_MAX})
  --max-cost-usd <n>  Spend limit (default: the configuration's maxCostUsd)
  --config <file>     Read this configuration file instead of the
                      repository's .ocra/config.json
  -h, --help          Show help
`;

// Where each learn command finds its evidence (ADR-0040).
const SOURCES = {
  mine: { what: "fix commits", candidates: (run: ResolvedRun) => fixCandidates(run.root) },
  feedback: {
    what: "review feedback",
    candidates: (run: ResolvedRun) => feedbackCandidates(run),
  },
  remember: {
    what: "remembered notes",
    candidates: (run: ResolvedRun) => rememberedCandidates(run.vcs),
  },
  import: {
    what: "documents",
    candidates: (run: ResolvedRun, documents: readonly string[]) =>
      documentCandidates(run.root, documents, run.target.trusted),
  },
} as const;
type Source = keyof typeof SOURCES;
const CHECK = "check";
const READS_CHANGE: ReadonlySet<string> = new Set<Source>(["remember", "feedback"]);

// The repository's accepted findings, then the pull or merge request's
// declined ones that the repository does not already hold.
async function feedbackCandidates(run: ResolvedRun): Promise<Candidate[]> {
  const accepted = await acceptedFindingCandidates(run.target.trusted);
  if (run.target.changeRequestNumber === undefined) return accepted;
  const held = new Set(accepted.map((c) => c.ref));
  const declined = await declinedFindingCandidates(run.vcs, run.target.trusted);
  return [...accepted, ...declined.filter((c) => !held.has(c.ref))];
}

export async function learnCommand(
  argv: string[],
  io: ReviewIo,
  deps: ReviewDeps,
): Promise<number> {
  const args = parseLearnArgs(argv, [...Object.keys(SOURCES), CHECK]);
  if (args === "help") {
    io.out.write(LEARN_USAGE);
    return EXIT.ok;
  }
  if (args.source === "remember" && args.change === undefined) {
    throw new UsageError("ocra learn remember needs --pr or --mr");
  }
  if (args.change !== undefined && !READS_CHANGE.has(args.source)) {
    throw new UsageError("--pr and --mr go with ocra learn remember and ocra learn feedback");
  }
  if (args.source === CHECK && args.propose) {
    throw new UsageError("--propose does not go with ocra learn check");
  }
  const reviewArgs: ReviewArgs = {
    target: { mode: "workspace" },
    format: "text",
    ...args.change,
    ...(args.maxCostUsd !== undefined ? { maxCostUsd: args.maxCostUsd } : {}),
    ...(args.configFile !== undefined ? { configFile: args.configFile } : {}),
  };
  const run = await resolveRun(reviewArgs, io, deps, { logged: false });
  if (args.source === CHECK) return checkLearnings(run, io);
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
    const proposed = await proposedLearnings(run.root, run.warn);
    const result = await learnFrom(
      await SOURCES[args.source as Source].candidates(
        run,
        args.documents.map((d) => resolve(deps.cwd, d)),
      ),
      {
        existing: run.learnings,
        proposed,
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
      const opened = await proposeLearnings(
        run,
        result.kept,
        created,
        deps,
        SOURCES[args.source as Source].what,
        {
          named: args.proposeOn,
          requireReview: args.requireReview,
          taken: proposed.map((l) => learningPath(l.id)),
        },
      );
      for (const warning of opened.warnings) run.warn(warning);
      io.out.write(`${forTerminal(opened.webUrl)}\n`);
      const noun = opened.platform === "gitlab" ? "Merge request" : "Pull request";
      io.err.write(`[ocra] ${noun} ${MERGE[opened.merge]}\n`);
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

const learningPath = (id: string) => `${LEARNINGS_DIR}/${id}.md`;

const MERGE = {
  enabled: "opened; it merges once its checks pass",
  merged: "opened and merged: no check was required",
  off: "opened for a person to review and merge",
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
    result.proposed > 0 ? `${result.proposed} already proposed` : "",
  ].filter((p) => p !== "");
  return `${parts.join(", ")}; $${spent.toFixed(4)}`;
}
