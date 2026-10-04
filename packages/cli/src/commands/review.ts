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
import type { CloudDeps } from "../cloud/deps.js";
import { EXIT } from "../io/exit.js";
import type { NpmRunner } from "../plugins/npm.js";
import type { ReviewArgs } from "./review/args.js";
import { deliver, writeReport } from "./review/deliver.js";
import { executeRun } from "./review/execute-run.js";
import { exitCode } from "./review/exit-code.js";
import { planRun } from "./review/plan-run.js";
import { type ReviewIo, resolveRun } from "./review/resolve-run.js";
import type { RuntimeLoaders } from "./review/runtimes.js";

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

export interface ReviewDeps {
  cwd: string;
  env: Readonly<Record<string, string | undefined>>;
  builtinPlugins: readonly OcraPlugin[];
  runtimes: RuntimeLoaders;
  writeFile(path: string, content: string): Promise<void>;
  now(): number;
  heartbeatMs: number;
  // Only tests replace it, to fake the GitHub and GitLab APIs.
  fetch?: typeof fetch;
  // ocra Cloud: the signed-in session, default models and the upload. Absent,
  // a review never reads a session or contacts ocra Cloud.
  cloud?: CloudDeps;
  // Runs npm for `ocra plugins`; only tests replace it.
  npm?: NpmRunner;
  // Calls the handler on Ctrl-C or SIGTERM; returns a function that stops listening.
  onInterrupt?(handler: () => void): () => void;
}

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
