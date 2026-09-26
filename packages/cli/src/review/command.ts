import { join, relative, resolve } from "node:path";
import {
  correctnessReviewerPlugin,
  defaultSelectionPolicy,
  newSessionId,
  type OcraPlugin,
  performanceReviewerPlugin,
  type ReviewerOverride,
  type ReviewerOverrides,
  type ReviewOptions,
  type ReviewReport,
  runReview,
  securityReviewerPlugin,
  sessionJsonlPlugin,
  startPlugins,
} from "@open-cr-agent/core";
import { opencodeRuntimePlugin } from "@open-cr-agent/runtime-opencode";
import { githubPlugin } from "@open-cr-agent/vcs-github";
import { findRepositoryRoot, localGitPlugin } from "@open-cr-agent/vcs-local";
import type { ReviewArgs } from "./args.js";
import { type CliConfig, ConfigError } from "./config.js";
import { type Output, ProgressPrinter } from "./progress.js";
import { renderJson, renderText } from "./render.js";
import { localTarget, pullRequestTarget } from "./target.js";
import { forTerminal } from "./terminal.js";

export const SESSIONS_DIR = ".ocra/sessions";

export const EXIT = { ok: 0, blocking: 1, error: 2, incomplete: 3, interrupted: 130 } as const;

export const BUILTIN_PLUGINS: readonly OcraPlugin[] = [
  localGitPlugin,
  githubPlugin,
  opencodeRuntimePlugin,
  correctnessReviewerPlugin,
  securityReviewerPlugin,
  performanceReviewerPlugin,
  sessionJsonlPlugin,
];

export interface ReviewDeps {
  cwd: string;
  env: Readonly<Record<string, string | undefined>>;
  builtinPlugins: readonly OcraPlugin[];
  writeFile(path: string, content: string): Promise<void>;
  now(): number;
  heartbeatMs: number;
  // Only tests replace it, to fake the GitHub API.
  fetch?: typeof fetch;
  // Calls the handler on Ctrl-C or SIGTERM; returns a function that stops listening.
  onInterrupt?(handler: () => void): () => void;
}

export async function reviewCommand(
  args: ReviewArgs,
  io: { out: Output; err: Output },
  deps: ReviewDeps,
): Promise<number> {
  const root = await findRepositoryRoot(deps.cwd);
  const warn = (message: string) => io.err.write(`[ocra] Warning: ${forTerminal(message)}\n`);
  const target = args.pullRequest
    ? await pullRequestTarget(args.pullRequest, deps.cwd, root, deps.env, warn, deps.fetch)
    : await localTarget(args, deps.cwd, root, deps.env, warn, deps.fetch);
  const { config } = target;
  const session = { dir: join(root, SESSIONS_DIR), id: newSessionId() };

  const registry = await startPlugins([...deps.builtinPlugins, ...target.plugins], {
    settings: { ...config.pluginSettings, [sessionJsonlPlugin.name]: session },
    env: deps.env,
    warn,
  });
  const vcs = target.createVcs(registry);
  const runtime = registry.createRuntime(config.runtime, { models: config.models, env: deps.env });
  const overrides = reviewerOverrides(
    config,
    args,
    registry.reviewers.map((r) => r.id),
  );

  const progress = new ProgressPrinter(io.err, { heartbeatMs: deps.heartbeatMs, now: deps.now });
  const interrupt = new AbortController();
  const stopListening = deps.onInterrupt?.(() => {
    io.err.write(
      "[ocra] Interrupted: stopping and writing a partial report (Ctrl-C again quits now)\n",
    );
    interrupt.abort();
  });
  let report: ReviewReport;
  try {
    report = await runReview({
      signal: interrupt.signal,
      ...runOptions(config),
      reviewerOverrides: overrides,
      ...(args.maxCostUsd !== undefined ? { maxCostUsd: args.maxCostUsd } : {}),
      ...(args.ultra ? { ultra: true } : {}),
      ...(target.readTrusted ? { readTrusted: target.readTrusted } : {}),
      vcs,
      runtime,
      reviewers: registry.reviewers,
      rules: [...registry.rules, ...config.rules],
      onEvent: (event) => {
        registry.emit(event);
        progress.onEvent(event);
      },
    });
  } finally {
    stopListening?.();
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
  if (interrupt.signal.aborted) return EXIT.interrupted;
  if (target.publish) {
    const published = await vcs.publish(report);
    for (const warning of published.warnings) warn(warning);
    io.err.write("[ocra] Published the review to the pull request\n");
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
  if (config.verify !== undefined) options.verify = config.verify;
  if (config.judge !== undefined) options.judge = config.judge;
  if (config.maxCostUsd !== undefined) options.maxCostUsd = config.maxCostUsd;
  if (config.runTimeoutMinutes !== undefined)
    options.runTimeoutMs = config.runTimeoutMinutes * 60_000;
  return options;
}

// --reviewers narrows the run to the named reviewers on top of the config.
function reviewerOverrides(
  config: CliConfig,
  args: ReviewArgs,
  registered: readonly string[],
): ReviewerOverrides {
  if (args.reviewers === undefined) return config.reviewers;
  const unknown = args.reviewers.filter((id) => !registered.includes(id));
  if (unknown.length > 0) {
    throw new ConfigError(
      `Unknown reviewer(s): ${unknown.join(", ")} (available: ${registered.join(", ")})`,
    );
  }
  const overrides: Record<string, ReviewerOverride> = { ...config.reviewers };
  for (const id of registered) {
    if (!args.reviewers.includes(id)) overrides[id] = { ...overrides[id], enabled: false };
  }
  return overrides;
}

function exitCode(report: ReviewReport, err: Output): number {
  if (report.tasks.length > 0 && report.tasks.every((t) => t.status !== "completed")) {
    err.write("[ocra] No review task completed; see the errors above.\n");
    return EXIT.error;
  }
  if (report.verdict === "significant_concerns") return EXIT.blocking;
  return report.tasks.some((t) => t.status !== "completed") ? EXIT.incomplete : EXIT.ok;
}
