import {
  errorMessage,
  type OcraPlugin,
  type PluginRegistry,
  type ReviewerOverride,
  type ReviewerOverrides,
  type SourcedRule,
  sessionJsonlPlugin,
  startPlugins,
  type VcsAdapter,
} from "@open-cr-agent/core";
import { newRunId } from "@open-cr-agent/core/internal";
import { findRepositoryRoot } from "@open-cr-agent/vcs-local/internal";
import type { CloudDeps } from "../../cloud/deps.js";
import { sessionLostWarning } from "../../cloud/review.js";
import { accountLayer, fetchAccountSettings } from "../../cloud/settings.js";
import { cloudEnabled } from "../../cloud/upload.js";
import {
  type CliConfig,
  ConfigError,
  type ResolvedConfig,
  resolveRunConfig,
} from "../../config/cli-config.js";
import type { SettingsLayer } from "../../config/settings.js";
import type { Output } from "../../io/output.js";
import { forTerminal } from "../../io/terminal.js";
import { type AccountPlugins, loadAccountPlugins } from "../../plugins/account.js";
import { pluginsDir } from "../../plugins/store.js";
import { sessionsDir } from "../../session/store.js";
import type { ReviewArgs } from "./args.js";
import type { ReviewDeps } from "./deps.js";
import type { RuntimeLoaders } from "./runtimes.js";
import { type AccountVersion, filledByAccount } from "./settings-sources.js";
import { type ReviewTarget, resolveReviewTarget } from "./target.js";

export interface ReviewIo {
  out: Output;
  err: Output;
}

// Everything a review or a plan needs, before either calls a model.
export interface ResolvedRun extends ResolvedConfig {
  root: string;
  target: ReviewTarget;
  warn: (message: string) => void;
  // Present while the machine is signed in to ocra Cloud and the session held.
  signedInCloud?: CloudDeps;
  accountSettings?: AccountVersion;
  // sealKey: this machine's, which seals the session (ADR-0031).
  session: RunSession;
  registry: PluginRegistry;
  // Aborted by the first Ctrl-C of the review; the platform adapter's
  // client, made before the review starts, already listens to it.
  interrupt: AbortController;
  vcs: VcsAdapter;
  rules: SourcedRule[];
  overrides: ReviewerOverrides;
}

interface RunSession {
  dir: string;
  id: string;
  sealKey?: string;
}

export async function resolveRun(
  args: ReviewArgs,
  io: ReviewIo,
  deps: ReviewDeps,
): Promise<ResolvedRun> {
  const root = await findRepositoryRoot(deps.cwd);
  const warn = (message: string) => io.err.write(`[ocra] Warning: ${forTerminal(message)}\n`);
  const interrupt = new AbortController();
  const target = await resolveReviewTarget(args, {
    cwd: deps.cwd,
    root,
    env: deps.env,
    warn,
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
    signal: interrupt.signal,
  });
  const account = await withAccount(deps.cloud, warn);
  const resolved = resolveRunConfig(
    {
      target: target.layers,
      ...(account.layer ? { account: account.layer } : {}),
      ultra: args.ultra === true,
    },
    warn,
  );
  const filled = filledByAccount(resolved.listed);
  if (filled.length > 0) {
    io.err.write(forTerminal(`[ocra] From your ocra Cloud settings: ${filled.join(", ")}\n`));
  }
  const session: RunSession = {
    dir: sessionsDir(root),
    id: newRunId(),
    ...(await sealKeyOf(args, deps, warn)),
  };
  const registry = await startRegistry(args, deps, {
    target,
    config: resolved.config,
    account: account.plugins,
    session,
    warn,
  });
  return {
    ...resolved,
    root,
    target,
    warn,
    ...(account.cloud ? { signedInCloud: account.cloud } : {}),
    ...(account.settings ? { accountSettings: account.settings } : {}),
    session,
    registry,
    interrupt,
    vcs: target.createVcs(registry),
    rules: [
      ...registry.rules.map((rule): SourcedRule => ({ ...rule, source: "plugin" })),
      ...resolved.config.rules,
    ],
    overrides: reviewerOverrides(
      resolved.config,
      args,
      registry.reviewers.map((r) => r.id),
    ),
  };
}

// The account's settings fill what the repository leaves out (ADR-0027);
// unreachable, they cost a warning, so a plan still works offline.
async function withAccount(
  cloudDeps: CloudDeps | undefined,
  warn: (message: string) => void,
): Promise<{
  layer?: SettingsLayer;
  cloud?: CloudDeps;
  settings?: AccountVersion;
  plugins: AccountPlugins;
}> {
  const none: AccountPlugins = { plugins: [], pluginSettings: {} };
  if (!cloudDeps || !(await cloudEnabled(cloudDeps, warn))) return { plugins: none };
  const account = await fetchAccountSettings(cloudDeps, warn);
  if (account.kind !== "read") {
    // Said once here; the rest of the run leaves ocra Cloud alone.
    if (account.kind !== "signed-out") warn(sessionLostWarning(account));
    return { plugins: none };
  }
  if (!account.settings) return { cloud: cloudDeps, plugins: account.plugins };
  return {
    layer: accountLayer(account.settings),
    cloud: cloudDeps,
    settings: { version: account.settings.version },
    plugins: account.plugins,
  };
}

// The key that seals the session; without it the review still runs, and
// only its session cannot be resumed.
async function sealKeyOf(
  args: ReviewArgs,
  deps: ReviewDeps,
  warn: (message: string) => void,
): Promise<{ sealKey?: string }> {
  if (args.plan || !deps.sessionKey) return {};
  try {
    return { sealKey: await deps.sessionKey() };
  } catch (error) {
    warn(`no session key on this machine (${errorMessage(error)}): this run cannot be resumed`);
    return {};
  }
}

// A plan calls no model, writes no session log and imports no runtime: it
// works without the optional runtime-opencode.
async function startRegistry(
  args: ReviewArgs,
  deps: ReviewDeps,
  run: {
    target: ReviewTarget;
    config: CliConfig;
    account: AccountPlugins;
    session: RunSession;
    warn: (message: string) => void;
  },
): Promise<PluginRegistry> {
  const { target, config, warn } = run;
  const builtins = args.plan
    ? deps.builtinPlugins.filter((p) => p.name !== sessionJsonlPlugin.name)
    : [...deps.builtinPlugins, ...(await builtinRuntime(deps.runtimes, config.runtime))];
  const account = await loadAccountPlugins(run.account, {
    allowed: target.accountPlugins,
    configured: config.plugins,
    taken: [...builtins, ...target.plugins],
    dir: pluginsDir(deps.env),
    warn,
  });
  // The repository's own settings win; a repository plugin's come from it alone.
  const pluginSettings = { ...account.settings, ...config.pluginSettings };
  return startPlugins([...builtins, ...target.plugins, ...account.plugins], {
    settings: args.plan
      ? pluginSettings
      : { ...pluginSettings, [sessionJsonlPlugin.name]: run.session },
    env: deps.env,
    warn,
  });
}

// A runtime not built in comes from a plugin of the configuration.
async function builtinRuntime(runtimes: RuntimeLoaders, name: string): Promise<OcraPlugin[]> {
  const load = Object.hasOwn(runtimes, name) ? runtimes[name] : undefined;
  return load ? [await load()] : [];
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
