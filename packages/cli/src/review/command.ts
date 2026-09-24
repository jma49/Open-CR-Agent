import { join, relative, resolve } from "node:path";
import {
  type AgentRuntime,
  defaultSelectionPolicy,
  JsonlSessionWriter,
  type ReviewOptions,
  type ReviewReport,
  runReview,
  type VcsAdapter,
} from "@open-cr-agent/core";
import type { LocalGitOptions } from "@open-cr-agent/vcs-local";
import type { ReviewArgs } from "./args.js";
import { type CliConfig, loadConfig } from "./config.js";
import { type Output, ProgressPrinter } from "./progress.js";
import { renderJson, renderText } from "./render.js";

export const SESSIONS_DIR = ".ocra/sessions";

export const EXIT = { ok: 0, blocking: 1, error: 2 } as const;

export interface ReviewVcs extends VcsAdapter {
  repositoryRoot(): Promise<string>;
}

export interface ReviewDeps {
  cwd: string;
  env: Readonly<Record<string, string | undefined>>;
  createVcs(options: LocalGitOptions): ReviewVcs;
  createRuntime(config: CliConfig): AgentRuntime;
  writeFile(path: string, content: string): Promise<void>;
  now(): number;
  heartbeatMs: number;
}

export async function reviewCommand(
  args: ReviewArgs,
  io: { out: Output; err: Output },
  deps: ReviewDeps,
): Promise<number> {
  const vcs = deps.createVcs({ cwd: deps.cwd, target: args.target });
  const root = await vcs.repositoryRoot();
  const config = await loadConfig(root, deps.env);
  const session = new JsonlSessionWriter(join(root, SESSIONS_DIR));
  const progress = new ProgressPrinter(io.err, { heartbeatMs: deps.heartbeatMs, now: deps.now });

  let report: ReviewReport;
  try {
    report = await runReview({
      ...runOptions(config),
      vcs,
      runtime: deps.createRuntime(config),
      onEvent: (event) => {
        session.write(event);
        progress.onEvent(event);
      },
    });
  } finally {
    progress.stop();
  }

  const sessionDir = relative(deps.cwd, session.dir) || ".";
  const rendered = args.format === "json" ? renderJson(report) : renderText(report, sessionDir);
  if (args.output === undefined) {
    io.out.write(rendered);
  } else {
    await deps.writeFile(resolve(deps.cwd, args.output), rendered);
    io.err.write(`[ocra] Wrote ${args.output}\n`);
  }
  return exitCode(report, io.err);
}

function runOptions(config: CliConfig): Omit<ReviewOptions, "vcs" | "runtime"> {
  const options: Omit<ReviewOptions, "vcs" | "runtime"> = {
    selection: { ...defaultSelectionPolicy, include: config.include, exclude: config.exclude },
  };
  if (config.concurrency !== undefined) options.concurrency = config.concurrency;
  if (config.taskTimeoutMinutes !== undefined)
    options.taskTimeoutMs = config.taskTimeoutMinutes * 60_000;
  if (config.runTimeoutMinutes !== undefined)
    options.runTimeoutMs = config.runTimeoutMinutes * 60_000;
  return options;
}

function exitCode(report: ReviewReport, err: Output): number {
  if (report.tasks.length > 0 && report.tasks.every((t) => t.status !== "completed")) {
    err.write("[ocra] No review task completed; see the errors above.\n");
    return EXIT.error;
  }
  return report.findings.some((f) => f.severity === "critical") ? EXIT.blocking : EXIT.ok;
}
