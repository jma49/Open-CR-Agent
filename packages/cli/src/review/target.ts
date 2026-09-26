import type { OcraPlugin, PluginRegistry, VcsAdapter } from "@open-cr-agent/core";
import { DEFAULT_BOT_LOGIN, GitHubApi } from "@open-cr-agent/vcs-github";
import { ensureCommits, LocalGitAdapter } from "@open-cr-agent/vcs-local";
import type { PullRequestTarget, ReviewArgs } from "./args.js";
import { type CliConfig, ConfigError, loadConfig } from "./config.js";
import { loadExternalPlugins } from "./plugins.js";

export interface ReviewTarget {
  config: CliConfig;
  plugins: OcraPlugin[];
  createVcs(registry: PluginRegistry): VcsAdapter;
  readTrusted?: (path: string) => Promise<string | undefined>;
  publish: boolean;
}

type Env = Readonly<Record<string, string | undefined>>;

export async function localTarget(
  args: ReviewArgs,
  cwd: string,
  root: string,
  env: Env,
): Promise<ReviewTarget> {
  const config = await loadConfig(root, env, { repository: !args.ignoreRepoConfig });
  return {
    config,
    plugins: await loadExternalPlugins(config.plugins, root),
    createVcs: (registry) => registry.createVcs("local", { cwd, target: args.target }),
    publish: false,
  };
}

// The pull request's own files are untrusted: configuration, guidelines and
// rules come from its base commit, and repository plugins never load.
export async function pullRequestTarget(
  pr: PullRequestTarget,
  cwd: string,
  root: string,
  env: Env,
  warn: (message: string) => void,
  fetchImpl?: typeof fetch,
): Promise<ReviewTarget> {
  const token = env.GITHUB_TOKEN ?? env.GH_TOKEN;
  if (!token) throw new ConfigError("--pr needs a GitHub token in GITHUB_TOKEN or GH_TOKEN");
  const [owner = "", repo = ""] = (pr.repo ?? (await repositoryName(root, env))).split("/");
  const apiOptions = { token, ...(env.GITHUB_API_URL ? { baseUrl: env.GITHUB_API_URL } : {}) };
  const api = new GitHubApi(
    { owner, repo },
    fetchImpl ? { ...apiOptions, fetch: fetchImpl } : apiOptions,
  );
  const pull = await api.getPullRequest(pr.number);
  await ensureCommits(root, [pull.base.sha, pull.head.sha], [`pull/${pr.number}/head`]);

  const base = new LocalGitAdapter({ cwd, target: { mode: "commit", commit: pull.base.sha } });
  const readTrusted = (path: string) => base.readFile(path);
  const config = await loadConfig(root, env, { repository: true, read: readTrusted });
  if (config.plugins.length > 0) {
    warn("plugins in .ocra/config.json are not loaded for pull requests");
  }
  const code = new LocalGitAdapter({
    cwd,
    target: { mode: "range", from: pull.base.sha, to: pull.head.sha },
  });
  return {
    config,
    plugins: [],
    createVcs: (registry) =>
      registry.createVcs("github", {
        owner,
        repo,
        number: pr.number,
        token,
        ...(env.GITHUB_API_URL ? { apiUrl: env.GITHUB_API_URL } : {}),
        botLogin: config.github.botLogin ?? DEFAULT_BOT_LOGIN,
        requestChanges: config.github.requestChanges ?? false,
        code,
        ...(fetchImpl ? { fetch: fetchImpl } : {}),
      }),
    readTrusted,
    publish: pr.publish,
  };
}

async function repositoryName(root: string, env: Env): Promise<string> {
  if (env.GITHUB_REPOSITORY) return env.GITHUB_REPOSITORY;
  const url = await new LocalGitAdapter({ cwd: root, target: { mode: "workspace" } })
    .remoteUrl("origin")
    .catch(() => undefined);
  const match = url && /github\.com[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?$/.exec(url);
  if (!match?.[1]) {
    throw new ConfigError("Cannot tell which GitHub repository this is; pass --repo owner/name");
  }
  return match[1];
}
