import {
  type AgentRuntime,
  type ReviewOptions,
  type ReviewReport,
  review,
  type SarifLog,
} from "@open-cr-agent/core";
import { defaultSelectionPolicy, REVIEW_DEFAULTS } from "@open-cr-agent/core/internal";
import { withCloudProviders } from "../../cloud/providers.js";
import { type CloudReview, prepareCloudReview } from "../../cloud/review.js";
import { agentChains, type CliConfig } from "../../config/cli-config.js";
import { VERSION } from "../../version.js";
import type { ReviewDeps } from "../review.js";
import type { ReviewArgs } from "./args.js";
import { ProgressPrinter } from "./progress.js";
import { configHash, requestedSampling } from "./provenance.js";
import type { ResolvedRun, ReviewIo } from "./resolve-run.js";
import { loadSarifLogs } from "./sarif-input.js";
import { accountOf } from "./settings-sources.js";

export interface ExecutedRun {
  report: ReviewReport;
  // Ctrl-C stopped the review; the report is partial.
  interrupted: boolean;
  // The repository's hash and the account's memory for it (ADR-0028), when
  // signed in to ocra Cloud.
  cloudReview?: CloudReview;
  // When the review started, for the duration ocra Cloud records.
  started: number;
}

type Prepared = Omit<ReviewOptions, "vcs" | "runtime" | "signal" | "onEvent">;

export async function executeRun(
  run: ResolvedRun,
  args: ReviewArgs,
  io: ReviewIo,
  deps: ReviewDeps,
): Promise<ExecutedRun> {
  const sarif = await loadSarifLogs(args.importSarif ?? [], deps.cwd);
  const cloudReview = run.signedInCloud
    ? await prepareCloudReview(run.root, run.signedInCloud, run.warn, run.target.repository)
    : undefined;
  const sampling = requestedSampling(run.config, args);
  const { runtime, stopCloud } = await startRuntime(run, deps, sampling);
  const progress = new ProgressPrinter(io.err, { heartbeatMs: deps.heartbeatMs, now: deps.now });
  const interrupt = new AbortController();
  const stopListening = deps.onInterrupt?.(() => {
    io.err.write(
      "[ocra] Interrupted: stopping and writing a partial report (Ctrl-C again quits now)\n",
    );
    interrupt.abort();
  });
  const started = deps.now();
  try {
    const report = await review({
      ...prepareReview(run, args, sampling, sarif, cloudReview),
      signal: interrupt.signal,
      vcs: run.vcs,
      runtime,
      onEvent: (event) => {
        run.registry.emit(event);
        progress.onEvent(event);
      },
    });
    return {
      report,
      interrupted: interrupt.signal.aborted,
      ...(cloudReview ? { cloudReview } : {}),
      started,
    };
  } finally {
    stopListening?.();
    progress.stop();
    stopCloud();
    await runtime.dispose?.();
  }
}

// The runtime the configuration names, with ocra Cloud's providers when signed in.
async function startRuntime(
  run: ResolvedRun,
  deps: ReviewDeps,
  sampling: ReturnType<typeof requestedSampling>,
): Promise<{ runtime: AgentRuntime; stopCloud: () => void }> {
  const { config } = run;
  const models = config.models;
  const agentModels = agentChains({ reviewers: run.overrides, roles: config.roles });
  const cloud = await withCloudProviders(
    [...Object.values(models), ...Object.values(agentModels)],
    config.providers,
    deps.env,
    // Even when the session was lost: an ocra- model then fails with why.
    deps.cloud,
    run.warn,
    {
      timeoutMs: config.runTimeoutMinutes
        ? config.runTimeoutMinutes * 60_000
        : REVIEW_DEFAULTS.runTimeoutMs,
      // The direct runtime reads a provider's key at each call (DirectRuntime.target).
      keyReadPerCall: config.runtime === "direct",
    },
  );
  try {
    const runtime = run.registry.createRuntime(config.runtime, {
      models,
      ...(Object.keys(agentModels).length > 0 ? { agentModels } : {}),
      env: cloud.env,
      providers: cloud.providers,
      ...(Object.keys(sampling).length > 0 ? { sampling } : {}),
    });
    return { runtime, stopCloud: () => cloud.stop() };
  } catch (error) {
    cloud.stop();
    throw error;
  }
}

function prepareReview(
  run: ResolvedRun,
  args: ReviewArgs,
  sampling: ReturnType<typeof requestedSampling>,
  sarif: readonly SarifLog[],
  cloudReview: CloudReview | undefined,
): Prepared {
  const { config, ultra, accountSettings } = run;
  return {
    runId: run.session.id,
    ...runOptions(config),
    models: config.models,
    reviewerOverrides: run.overrides,
    provenance: {
      ocraVersion: VERSION,
      configHash: configHash(config, ultra ? { ...args, ultra: true } : args, accountSettings),
      sampling,
      ...accountOf(accountSettings),
    },
    ...(args.maxCostUsd !== undefined ? { maxCostUsd: args.maxCostUsd } : {}),
    ...(ultra ? { ultra: true } : {}),
    ...(args.full ? { fullReview: true } : {}),
    ...(sarif.length > 0 ? { sarif } : {}),
    ...(run.target.readTrusted ? { readTrusted: run.target.readTrusted } : {}),
    reviewers: run.registry.reviewers,
    rules: run.rules,
    ...(cloudReview?.memory.length ? { accountMemory: cloudReview.memory } : {}),
  };
}

function runOptions(config: CliConfig): Omit<ReviewOptions, "vcs" | "runtime"> {
  const options: Omit<ReviewOptions, "vcs" | "runtime"> = {
    selection: { ...defaultSelectionPolicy, include: config.include, exclude: config.exclude },
    effort: config.effort,
    roles: config.roles,
  };
  if (config.concurrency !== undefined) options.concurrency = config.concurrency;
  if (config.taskTimeoutMinutes !== undefined)
    options.taskTimeoutMs = config.taskTimeoutMinutes * 60_000;
  if (config.verify !== undefined) options.verify = config.verify;
  if (config.judge !== undefined) options.judge = config.judge;
  if (config.maxCostUsd !== undefined) options.maxCostUsd = config.maxCostUsd;
  if (config.maxTasks !== undefined) options.maxTasks = config.maxTasks;
  if (config.runTimeoutMinutes !== undefined)
    options.runTimeoutMs = config.runTimeoutMinutes * 60_000;
  return options;
}
