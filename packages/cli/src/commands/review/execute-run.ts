import {
  type AgentRuntime,
  OcraError,
  type ResumedRun,
  type ReviewOptions,
  type ReviewReport,
  review,
  type SarifLog,
} from "@open-cr-agent/core";
import { REVIEW_DEFAULTS, readResumedRun } from "@open-cr-agent/core/internal";
import { withCloudProviders } from "../../cloud/providers.js";
import { type CloudReview, prepareCloudReview } from "../../cloud/review.js";
import { agentChains } from "../../config/cli-config.js";
import { VERSION } from "../../version.js";
import type { ReviewArgs } from "./args.js";
import type { ReviewDeps } from "./deps.js";
import { ProgressPrinter } from "./progress.js";
import { configHash, requestedSampling } from "./provenance.js";
import type { ResolvedRun, ReviewIo } from "./resolve-run.js";
import { configuredOptions } from "./review-options.js";
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
  const resume = args.resume ? await resumedRun(run, args.resume) : undefined;
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
      ...(resume ? { resume } : {}),
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

// The earlier run --resume names, from what ocra sealed on this machine.
function resumedRun(run: ResolvedRun, runId: string): Promise<ResumedRun> {
  const { dir, sealKey } = run.session;
  if (!sealKey) {
    throw new OcraError(
      "INPUT_INVALID",
      "--resume: this machine has no usable session key, so no session can be checked",
    );
  }
  return readResumedRun(dir, runId, sealKey, run.warn);
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
    ...configuredOptions(run, args),
    identity: {
      runId: run.session.id,
      provenance: {
        ocraVersion: VERSION,
        configHash: configHash(config, ultra ? { ...args, ultra: true } : args, accountSettings),
        sampling,
        ...accountOf(accountSettings),
      },
    },
    ...(sarif.length > 0 ? { sarif } : {}),
    ...(cloudReview?.memory.length ? { accountMemory: cloudReview.memory } : {}),
  };
}
