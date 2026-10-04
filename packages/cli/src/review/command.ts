import { join, relative, resolve } from "node:path";
import {
  agentsMdReviewerPlugin,
  correctnessReviewerPlugin,
  coverageGaps,
  docsReviewerPlugin,
  type OcraPlugin,
  performanceReviewerPlugin,
  type ReviewerOverride,
  type ReviewerOverrides,
  type ReviewOptions,
  type ReviewReport,
  review,
  type SourcedRule,
  securityReviewerPlugin,
  sessionJsonlPlugin,
  startPlugins,
} from "@open-cr-agent/core";
import {
  defaultSelectionPolicy,
  newRunId,
  previewReview,
  toPlanOutput,
} from "@open-cr-agent/core/internal";
import { githubPlugin } from "@open-cr-agent/vcs-github";
import { gitlabPlugin } from "@open-cr-agent/vcs-gitlab";
import { localGitPlugin } from "@open-cr-agent/vcs-local";
import { findRepositoryRoot } from "@open-cr-agent/vcs-local/internal";
import type { CloudDeps } from "../cloud.js";
import { pluginsDir } from "../plugin-store.js";
import type { NpmRunner } from "../plugins-command.js";
import { VERSION } from "../version.js";
import { type AccountPlugins, accountPlugins } from "./account-plugins.js";
import type { ReviewArgs } from "./args.js";
import { withCloudProviders } from "./cloud-providers.js";
import { fetchAccountSettings, layerAccountSettings } from "./cloud-settings.js";
import { cloudEnabled, repoHash, uploadOf, uploadReview } from "./cloud-upload.js";
import { agentChains, type CliConfig, ConfigError } from "./config.js";
import { renderPlan } from "./plan-render.js";
import { type Output, ProgressPrinter } from "./progress.js";
import { configHash, requestedSampling } from "./provenance.js";
import { renderJson, renderText, safeJson } from "./render.js";
import type { RuntimeLoaders } from "./runtimes.js";
import { renderSarif } from "./sarif.js";
import { loadSarifLogs } from "./sarif-input.js";
import { effectiveSettings, renderSettings } from "./settings-sources.js";
import { localTarget, mergeRequestTarget, pullRequestTarget } from "./target.js";
import { forTerminal } from "./terminal.js";

export const SESSIONS_DIR = ".ocra/sessions";

export const EXIT = { ok: 0, blocking: 1, error: 2, incomplete: 3, interrupted: 130 } as const;

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

export async function reviewCommand(
  args: ReviewArgs,
  io: { out: Output; err: Output },
  deps: ReviewDeps,
): Promise<number> {
  const root = await findRepositoryRoot(deps.cwd);
  const warn = (message: string) => io.err.write(`[ocra] Warning: ${forTerminal(message)}\n`);
  const ignoreRepoConfig = args.ignoreRepoConfig === true;
  const configFile = args.configFile ? resolve(deps.cwd, args.configFile) : undefined;
  const localArgs = configFile ? { ...args, configFile } : args;
  const target = args.pullRequest
    ? await pullRequestTarget(
        args.pullRequest,
        deps.cwd,
        root,
        deps.env,
        warn,
        deps.fetch,
        ignoreRepoConfig,
        configFile,
      )
    : args.mergeRequest
      ? await mergeRequestTarget(
          args.mergeRequest,
          deps.cwd,
          root,
          deps.env,
          warn,
          deps.fetch,
          ignoreRepoConfig,
          configFile,
        )
      : await localTarget(localArgs, deps.cwd, root, deps.env, warn, deps.fetch);
  // The account's settings fill what the repository leaves out (ADR-0027);
  // unreachable, they cost a warning, so a plan still works offline.
  const cloudDeps = deps.cloud;
  const signedIn = cloudDeps !== undefined && (await cloudEnabled(cloudDeps));
  let config = target.config;
  let filled: string[] = [];
  let fromAccount: AccountPlugins = { plugins: [], pluginSettings: {} };
  if (cloudDeps && signedIn) {
    const account = await fetchAccountSettings(cloudDeps, warn);
    if (account?.settings) {
      ({ config, filled } = layerAccountSettings(config, account.settings));
      // The account's default for --ultra; there is no --no-ultra to refuse it.
      if (account.settings.ultra === true && !args.ultra) filled.push("ultra");
      if (filled.length > 0) {
        io.err.write(`[ocra] From your ocra Cloud settings: ${filled.join(", ")}\n`);
      }
    }
    if (account) fromAccount = account.plugins;
  }
  const ultra = args.ultra === true || filled.includes("ultra");
  const session = { dir: join(root, SESSIONS_DIR), id: newRunId() };

  // A plan calls no model, writes no session log and imports no runtime: it
  // works without the optional runtime-opencode.
  const builtins = args.plan
    ? deps.builtinPlugins.filter((p) => p.name !== sessionJsonlPlugin.name)
    : [...deps.builtinPlugins, ...(await builtinRuntime(deps.runtimes, config.runtime))];
  const account = await accountPlugins(fromAccount, {
    allowed: target.accountPlugins,
    configured: config.plugins,
    taken: [...builtins, ...target.plugins],
    dir: pluginsDir(deps.env),
    warn,
  });
  // The repository's own settings win; a repository plugin's come from it alone.
  const pluginSettings = { ...account.settings, ...config.pluginSettings };
  const registry = await startPlugins([...builtins, ...target.plugins, ...account.plugins], {
    settings: args.plan
      ? pluginSettings
      : { ...pluginSettings, [sessionJsonlPlugin.name]: session },
    env: deps.env,
    warn,
  });
  const vcs = target.createVcs(registry);
  const rules: SourcedRule[] = [
    ...registry.rules.map((rule): SourcedRule => ({ ...rule, source: "plugin" })),
    ...config.rules,
  ];
  const overrides = reviewerOverrides(
    config,
    args,
    registry.reviewers.map((r) => r.id),
  );

  if (args.plan) {
    const preview = await previewReview({
      vcs,
      reviewers: registry.reviewers,
      reviewerOverrides: overrides,
      effort: config.effort,
      roles: config.roles,
      models: config.models,
      rules,
      selection: { ...defaultSelectionPolicy, include: config.include, exclude: config.exclude },
      ...(target.readTrusted ? { readTrusted: target.readTrusted } : {}),
      ...(ultra ? { ultra: true } : {}),
      ...(config.maxTasks !== undefined ? { maxTasks: config.maxTasks } : {}),
    });
    const settings = effectiveSettings(target.config, config, filled);
    const rendered =
      args.format === "json"
        ? `${safeJson({ ...toPlanOutput(preview), settings, ...accountOf(config) })}\n`
        : renderPlan(preview) + renderSettings(settings, config.accountSettings);
    if (args.output === undefined) io.out.write(rendered);
    else await deps.writeFile(resolve(deps.cwd, args.output), rendered);
    return EXIT.ok;
  }

  const sarif = await loadSarifLogs(args.importSarif ?? [], deps.cwd);
  const sampling = requestedSampling(config, args);
  const models = config.models;
  const agentModels = agentChains({ reviewers: overrides, roles: config.roles });
  const cloud = await withCloudProviders(
    [...Object.values(models), ...Object.values(agentModels)],
    config.providers,
    deps.env,
    cloudDeps,
    warn,
  );
  const runtime = registry.createRuntime(config.runtime, {
    models,
    ...(Object.keys(agentModels).length > 0 ? { agentModels } : {}),
    env: cloud.env,
    providers: cloud.providers,
    ...(Object.keys(sampling).length > 0 ? { sampling } : {}),
  });

  const progress = new ProgressPrinter(io.err, { heartbeatMs: deps.heartbeatMs, now: deps.now });
  const interrupt = new AbortController();
  const stopListening = deps.onInterrupt?.(() => {
    io.err.write(
      "[ocra] Interrupted: stopping and writing a partial report (Ctrl-C again quits now)\n",
    );
    interrupt.abort();
  });
  let report: ReviewReport;
  const started = deps.now();
  try {
    report = await review({
      runId: session.id,
      signal: interrupt.signal,
      ...runOptions(config),
      models,
      reviewerOverrides: overrides,
      provenance: {
        ocraVersion: VERSION,
        configHash: configHash(config, ultra ? { ...args, ultra: true } : args),
        sampling,
        ...accountOf(config),
      },
      ...(args.maxCostUsd !== undefined ? { maxCostUsd: args.maxCostUsd } : {}),
      ...(ultra ? { ultra: true } : {}),
      ...(args.full ? { fullReview: true } : {}),
      ...(sarif.length > 0 ? { sarif } : {}),
      ...(target.readTrusted ? { readTrusted: target.readTrusted } : {}),
      vcs,
      runtime,
      reviewers: registry.reviewers,
      rules,
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
  const rendered =
    args.format === "json"
      ? renderJson(report)
      : args.format === "sarif"
        ? renderSarif(report, VERSION)
        : renderText(report, sessionDir);
  if (args.output === undefined) {
    io.out.write(rendered);
  } else {
    await deps.writeFile(resolve(deps.cwd, args.output), rendered);
    io.err.write(`[ocra] Wrote ${args.output}\n`);
  }
  if (interrupt.signal.aborted) return EXIT.interrupted;
  if (target.publish) {
    // Stopping halfway could post the inline comments without the summary
    // that remembers them; a first Ctrl-C only warns.
    const stopHolding = deps.onInterrupt?.(() => {
      io.err.write(
        "[ocra] Publishing; Ctrl-C again quits now and may leave the pull request half updated\n",
      );
    });
    try {
      const published = await vcs.publish(report);
      for (const warning of published.warnings) warn(warning);
    } finally {
      stopHolding?.();
    }
    io.err.write(`[ocra] Published the review to the ${target.publishesTo ?? "change request"}\n`);
  }
  if (signedIn && cloudDeps && !args.noUpload) {
    const source = args.pullRequest ? "github" : args.mergeRequest ? "gitlab" : "local";
    const upload = uploadOf(
      report,
      source,
      await repoHash(root, cloudDeps.credentialsPath),
      deps.now() - started,
    );
    if (await uploadReview(upload, cloudDeps, warn)) {
      io.err.write("[ocra] Sent this review's counts to ocra Cloud (--no-upload to skip)\n");
    }
  }
  return exitCode(report, io.err);
}

function accountOf(config: CliConfig): { accountSettings?: { version: string | null } } {
  return config.accountSettings ? { accountSettings: config.accountSettings } : {};
}

// A runtime not built in comes from a plugin of the configuration.
async function builtinRuntime(runtimes: RuntimeLoaders, name: string): Promise<OcraPlugin[]> {
  const load = Object.hasOwn(runtimes, name) ? runtimes[name] : undefined;
  return load ? [await load()] : [];
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
  // Incomplete comes first, even over a blocking verdict: the action lets
  // exit 1 pass unless fail-on-concerns is set, and a review that missed
  // files or could not check a critical finding must never pass.
  const { notReviewed } = coverageGaps(report);
  if (notReviewed > 0) {
    err.write(
      `[ocra] ${notReviewed} selected file(s) were not reviewed; the review is incomplete.\n`,
    );
    return EXIT.incomplete;
  }
  if (report.unverifiedCriticals > 0) {
    err.write(
      `[ocra] ${report.unverifiedCriticals} critical finding(s) could not be verified; the review is incomplete.\n`,
    );
    return EXIT.incomplete;
  }
  if (report.verdict !== "significant_concerns") return EXIT.ok;
  const override = report.changeRequest.override;
  if (!override) return EXIT.blocking;
  err.write(
    `[ocra] The blocking verdict was overridden by ${forTerminal(override.by)}: ${forTerminal(override.reason)}\n`,
  );
  return EXIT.ok;
}
