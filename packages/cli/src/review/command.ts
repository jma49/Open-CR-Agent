import { join, relative, resolve } from "node:path";
import {
  correctnessReviewerPlugin,
  defaultSelectionPolicy,
  newSessionId,
  type OcraPlugin,
  type ReviewOptions,
  type ReviewReport,
  runReview,
  sessionJsonlPlugin,
  startPlugins,
} from "@open-cr-agent/core";
import { opencodeRuntimePlugin } from "@open-cr-agent/runtime-opencode";
import { findRepositoryRoot, localGitPlugin } from "@open-cr-agent/vcs-local";
import type { ReviewArgs } from "./args.js";
import { type CliConfig, loadConfig } from "./config.js";
import { loadExternalPlugins } from "./plugins.js";
import { type Output, ProgressPrinter } from "./progress.js";
import { renderJson, renderText } from "./render.js";
import { forTerminal } from "./terminal.js";

export const SESSIONS_DIR = ".ocra/sessions";

export const EXIT = { ok: 0, blocking: 1, error: 2 } as const;

export const BUILTIN_PLUGINS: readonly OcraPlugin[] = [
  localGitPlugin,
  opencodeRuntimePlugin,
  correctnessReviewerPlugin,
  sessionJsonlPlugin,
];

export interface ReviewDeps {
  cwd: string;
  env: Readonly<Record<string, string | undefined>>;
  builtinPlugins: readonly OcraPlugin[];
  writeFile(path: string, content: string): Promise<void>;
  now(): number;
  heartbeatMs: number;
}

export async function reviewCommand(
  args: ReviewArgs,
  io: { out: Output; err: Output },
  deps: ReviewDeps,
): Promise<number> {
  const root = await findRepositoryRoot(deps.cwd);
  const config = await loadConfig(root, deps.env, { repository: !args.ignoreRepoConfig });
  const external = await loadExternalPlugins(config.plugins, root);
  const session = { dir: join(root, SESSIONS_DIR), id: newSessionId() };

  const registry = await startPlugins([...deps.builtinPlugins, ...external], {
    settings: { ...config.pluginSettings, [sessionJsonlPlugin.name]: session },
    env: deps.env,
    warn: (message) => io.err.write(`[ocra] Warning: ${forTerminal(message)}\n`),
  });
  const vcs = registry.createVcs("local", { cwd: deps.cwd, target: args.target });
  const runtime = registry.createRuntime(config.runtime, { models: config.models, env: deps.env });

  const progress = new ProgressPrinter(io.err, { heartbeatMs: deps.heartbeatMs, now: deps.now });
  let report: ReviewReport;
  try {
    report = await runReview({
      ...runOptions(config),
      vcs,
      runtime,
      reviewers: registry.reviewers,
      rules: registry.rules,
      onEvent: (event) => {
        registry.emit(event);
        progress.onEvent(event);
      },
    });
  } finally {
    progress.stop();
    await runtime.dispose?.();
  }

  const sessionDir = relative(deps.cwd, join(session.dir, session.id)) || ".";
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
    reviewerOverrides: config.reviewers,
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
