import {
  agentsMdReviewerPlugin,
  correctnessReviewerPlugin,
  docsReviewerPlugin,
  type OcraPlugin,
  performanceReviewerPlugin,
  securityReviewerPlugin,
  sessionJsonlPlugin,
} from "@open-cr-agent/core";
import { githubPlugin } from "@open-cr-agent/vcs-github";
import { gitlabPlugin } from "@open-cr-agent/vcs-gitlab";
import { localGitPlugin } from "@open-cr-agent/vcs-local";
import { EXIT } from "../io/exit.js";
import type { ReviewArgs } from "./review/args.js";
import { deliver, writeReport } from "./review/deliver.js";
import type { ReviewDeps } from "./review/deps.js";
import { executeRun } from "./review/execute-run.js";
import { exitCode } from "./review/exit-code.js";
import { planRun } from "./review/plan-run.js";
import { type ReviewIo, resolveRun } from "./review/resolve-run.js";

export const BUILTIN_PLUGINS: readonly OcraPlugin[] = [
  localGitPlugin,
  githubPlugin,
  gitlabPlugin,
  correctnessReviewerPlugin,
  securityReviewerPlugin,
  performanceReviewerPlugin,
  docsReviewerPlugin,
  agentsMdReviewerPlugin,
  sessionJsonlPlugin,
];

// resolveRun → plan | execute → write → deliver (publish, upload) → exit code.
export async function reviewCommand(
  args: ReviewArgs,
  io: ReviewIo,
  deps: ReviewDeps,
): Promise<number> {
  const run = await resolveRun(args, io, deps);
  if (args.plan) return planRun(run, args, io, deps);
  const executed = await executeRun(run, args, io, deps);
  await writeReport(run, executed, args, io, deps);
  if (executed.interrupted) return EXIT.interrupted;
  await deliver(run, executed, args, io, deps);
  return exitCode(executed.report, io.err);
}
