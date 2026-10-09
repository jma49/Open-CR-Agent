import { dirname, resolve } from "node:path";
import type { OcraPlugin, PluginRegistry, VcsAdapter } from "@open-cr-agent/core";
import { resolveGitHubTarget } from "@open-cr-agent/vcs-github";
import { resolveGitLabTarget } from "@open-cr-agent/vcs-gitlab";
import {
  ensureCommits,
  filesChangedSince,
  LocalGitAdapter,
} from "@open-cr-agent/vcs-local/internal";
import type {
  ChangeRequestRef,
  LocalCode,
  PlatformTarget,
  ResolveTargetOptions,
} from "@open-cr-agent/vcs-platform";
import { type CliConfig, loadConfigLayers } from "../../config/cli-config.js";
import type { SettingsLayer } from "../../config/settings.js";
import { loadExternalPlugins } from "../../plugins/load.js";
import { repositoryOfWebUrl } from "../../repository-id.js";
import type { ReviewArgs } from "./args.js";

// A change request found on its platform, its adapter taking the platform's
// settings from the configuration.
type FoundChangeRequest = Omit<PlatformTarget<unknown>, "createVcs"> & {
  createVcs(registry: PluginRegistry, local: LocalCode, config: CliConfig): VcsAdapter;
};

type FindChangeRequest = (options: ResolveTargetOptions) => Promise<FoundChangeRequest>;

function platform<S>(
  resolveTarget: (options: ResolveTargetOptions) => Promise<PlatformTarget<S>>,
  settings: (config: CliConfig) => S,
): FindChangeRequest {
  return async (options) => {
    const target = await resolveTarget(options);
    return {
      ...target,
      createVcs: (registry, local, config) => target.createVcs(registry, local, settings(config)),
    };
  };
}

// The code review platforms ocra publishes to.
const PLATFORMS = {
  github: platform(resolveGitHubTarget, (config) => config.github),
  gitlab: platform(resolveGitLabTarget, () => ({})),
} satisfies Record<string, FindChangeRequest>;

type Platform = "local" | keyof typeof PLATFORMS;

// What a review published to a platform lands on, as the output names it.
export const CHANGE_REQUEST = {
  github: "pull request",
  gitlab: "merge request",
} as const satisfies Record<keyof typeof PLATFORMS, string>;

export interface ReviewTarget {
  platform: Platform;
  // The configuration's layers (settings.ts), for the review to put the
  // account's and the command line's on.
  layers: SettingsLayer[];
  plugins: OcraPlugin[];
  // Whether plugins the ocra Cloud account names may load (ADR-0027): only
  // where the repository's could.
  accountPlugins: boolean;
  createVcs(registry: PluginRegistry): VcsAdapter;
  readTrusted?: (path: string) => Promise<string | undefined>;
  publish: boolean;
  // The reviewed repository as `https://host/owner/repo` when it is not
  // the checkout's origin: the pull or merge request's (repository-id.ts).
  repository?: string;
}

export interface TargetOptions {
  cwd: string;
  root: string;
  env: Readonly<Record<string, string | undefined>>;
  warn: (message: string) => void;
  fetch?: typeof fetch;
  // The run's interrupt, for the platform's client.
  signal?: AbortSignal;
}

interface Inputs extends TargetOptions {
  ignoreRepoConfig: boolean;
  configFile?: string;
}

export async function resolveReviewTarget(
  args: ReviewArgs,
  options: TargetOptions,
): Promise<ReviewTarget> {
  const inputs: Inputs = {
    ...options,
    ignoreRepoConfig: args.ignoreRepoConfig === true,
    ...(args.configFile ? { configFile: resolve(options.cwd, args.configFile) } : {}),
  };
  const change = changeRequestOf(args);
  return change ? changeRequestTarget(change, inputs) : localTarget(args, inputs);
}

interface ChangeRequestArgs {
  platform: keyof typeof PLATFORMS;
  ref: ChangeRequestRef;
  publish: boolean;
}

function changeRequestOf(args: ReviewArgs): ChangeRequestArgs | undefined {
  const pr = args.pullRequest;
  if (pr) {
    const ref = { number: pr.number, ...(pr.repo ? { repository: pr.repo } : {}) };
    return { platform: "github", ref, publish: pr.publish };
  }
  const mr = args.mergeRequest;
  if (mr) {
    const ref = { number: mr.iid, ...(mr.project ? { repository: mr.project } : {}) };
    return { platform: "gitlab", ref, publish: mr.publish };
  }
  return undefined;
}

async function localTarget(args: ReviewArgs, inputs: Inputs): Promise<ReviewTarget> {
  const { cwd, root, configFile, ignoreRepoConfig } = inputs;
  const { config, layers } = await loadConfigLayers(root, inputs.env, {
    repository: !ignoreRepoConfig,
    ...(configFile ? { file: configFile } : {}),
    warn: inputs.warn,
    ...(inputs.fetch ? { fetch: inputs.fetch } : {}),
  });
  return {
    platform: "local",
    layers,
    // Plugins named by the user's own file are resolved from where it is.
    plugins: await loadExternalPlugins(config.plugins, configFile ? dirname(configFile) : root),
    accountPlugins: !ignoreRepoConfig,
    createVcs: (registry) => registry.createVcs("local", { cwd, target: args.target }),
    ...(ignoreRepoConfig ? { readTrusted: untrustedTreeReader(args, cwd) } : {}),
    publish: false,
  };
}

// --no-repo-config is for code you do not trust, so the files that steer a
// review (.ocra/memory.json can silence findings, rules and AGENTS.md shape
// the prompts) are not taken from it either: from the base of a range, which
// you chose, and otherwise not at all.
function untrustedTreeReader(
  args: ReviewArgs,
  cwd: string,
): (path: string) => Promise<string | undefined> {
  if (args.target.mode !== "range") return async () => undefined;
  const base = new LocalGitAdapter({ cwd, target: { mode: "commit", commit: args.target.from } });
  return (path) => base.readFile(path);
}

// The change request's own files are untrusted: configuration, guidelines
// and rules come from its base commit, and repository plugins never load.
async function changeRequestTarget(
  change: ChangeRequestArgs,
  inputs: Inputs,
): Promise<ReviewTarget> {
  const { cwd, root, configFile, warn } = inputs;
  const found = await PLATFORMS[change.platform]({
    ref: change.ref,
    env: inputs.env,
    origin: () => originUrl(root),
    warn,
    ...(inputs.fetch ? { fetch: inputs.fetch } : {}),
    ...(inputs.signal ? { signal: inputs.signal } : {}),
  });
  await ensureCommits(root, [found.baseSha, found.headSha], found.headRefs);

  const base = new LocalGitAdapter({ cwd, target: { mode: "commit", commit: found.baseSha } });
  const readTrusted = (path: string) => base.readFile(path);
  const { config, layers } = await loadConfigLayers(root, inputs.env, {
    repository: !inputs.ignoreRepoConfig,
    read: readTrusted,
    ...(configFile ? { file: configFile } : {}),
    warn,
    ...(inputs.fetch ? { fetch: inputs.fetch } : {}),
  });
  if (config.plugins.length > 0) {
    warn(`plugins in the configuration are not loaded for ${CHANGE_REQUEST[change.platform]}s`);
  }
  const local: LocalCode = {
    code: new LocalGitAdapter({
      cwd,
      target: { mode: "range", from: found.baseSha, to: found.headSha },
    }),
    history: { filesChangedSince: (from, to) => filesChangedSince(root, from, to) },
  };
  const repository = repositoryOfWebUrl(found.webUrl);
  return {
    platform: change.platform,
    layers,
    plugins: [],
    accountPlugins: false,
    createVcs: (registry) => found.createVcs(registry, local, config),
    readTrusted,
    publish: change.publish,
    ...(repository ? { repository } : {}),
  };
}

function originUrl(root: string): Promise<string | undefined> {
  return new LocalGitAdapter({ cwd: root, target: { mode: "workspace" } })
    .remoteUrl("origin")
    .catch(() => undefined);
}
