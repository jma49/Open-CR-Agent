import type { OcraPlugin, PluginRegistry, VcsAdapter } from "@open-cr-agent/core";
import { DEFAULT_BOT_LOGIN, GitHubApi } from "@open-cr-agent/vcs-github";
import { GitLabApi } from "@open-cr-agent/vcs-gitlab";
import { ensureCommits, filesChangedSince, LocalGitAdapter } from "@open-cr-agent/vcs-local";
import type { MergeRequestTarget, PullRequestTarget, ReviewArgs } from "./args.js";
import { type CliConfig, ConfigError, loadConfig } from "./config.js";
import { loadExternalPlugins } from "./plugins.js";

export interface ReviewTarget {
  config: CliConfig;
  plugins: OcraPlugin[];
  createVcs(registry: PluginRegistry): VcsAdapter;
  readTrusted?: (path: string) => Promise<string | undefined>;
  publish: boolean;
  // What a published review lands on: "pull request" or "merge request".
  publishesTo?: string;
}

type Env = Readonly<Record<string, string | undefined>>;

export async function localTarget(
  args: ReviewArgs,
  cwd: string,
  root: string,
  env: Env,
  warn: (message: string) => void,
  fetchImpl?: typeof fetch,
): Promise<ReviewTarget> {
  const config = await loadConfig(root, env, {
    repository: !args.ignoreRepoConfig,
    warn,
    ...(fetchImpl ? { fetch: fetchImpl } : {}),
  });
  return {
    config,
    plugins: await loadExternalPlugins(config.plugins, root),
    createVcs: (registry) => registry.createVcs("local", { cwd, target: args.target }),
    ...(args.ignoreRepoConfig ? { readTrusted: untrustedTreeReader(args, cwd) } : {}),
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

// The pull request's own files are untrusted: configuration, guidelines and
// rules come from its base commit, and repository plugins never load.
export async function pullRequestTarget(
  pr: PullRequestTarget,
  cwd: string,
  root: string,
  env: Env,
  warn: (message: string) => void,
  fetchImpl?: typeof fetch,
  ignoreRepoConfig = false,
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
  const config = await loadConfig(root, env, {
    repository: !ignoreRepoConfig,
    read: readTrusted,
    warn,
    ...(fetchImpl ? { fetch: fetchImpl } : {}),
  });
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
        snapshot: pull,
        history: {
          filesChangedSince: (from: string, to: string) => filesChangedSince(root, from, to),
        },
        ...(fetchImpl ? { fetch: fetchImpl } : {}),
      }),
    readTrusted,
    publish: pr.publish,
    publishesTo: "pull request",
  };
}

const GITLAB_API = "https://gitlab.com/api/v4";

// Like a pull request: configuration, guidelines and rules come from the
// target branch the merge request was based on, and repository plugins never
// load. GitLab CI sets CI_API_V4_URL and CI_PROJECT_ID; GITLAB_TOKEN must be
// a token that may write notes, which CI_JOB_TOKEN may not.
export async function mergeRequestTarget(
  mr: MergeRequestTarget,
  cwd: string,
  root: string,
  env: Env,
  warn: (message: string) => void,
  fetchImpl?: typeof fetch,
  ignoreRepoConfig = false,
): Promise<ReviewTarget> {
  const token = env.GITLAB_TOKEN;
  if (!token) {
    throw new ConfigError(
      "--mr needs a GitLab token in GITLAB_TOKEN: a project access token with the api scope and the Developer role (CI_JOB_TOKEN cannot post comments)",
    );
  }
  const project = mr.project ?? env.CI_PROJECT_ID ?? (await gitlabProject(root));
  const apiUrl = env.CI_API_V4_URL ?? GITLAB_API;
  const api = new GitLabApi(project, {
    token,
    baseUrl: apiUrl,
    ...(fetchImpl ? { fetch: fetchImpl } : {}),
  });
  const merge = await api.getMergeRequest(mr.iid);
  const refs = merge.diff_refs;
  if (!refs) throw new ConfigError(`merge request !${mr.iid} has no diff yet; try again shortly`);
  await ensureCommits(
    root,
    [refs.start_sha, refs.head_sha],
    [`refs/merge-requests/${mr.iid}/head`],
  );

  const base = new LocalGitAdapter({ cwd, target: { mode: "commit", commit: refs.start_sha } });
  const readTrusted = (path: string) => base.readFile(path);
  const config = await loadConfig(root, env, {
    repository: !ignoreRepoConfig,
    read: readTrusted,
    warn,
    ...(fetchImpl ? { fetch: fetchImpl } : {}),
  });
  if (config.plugins.length > 0) {
    warn("plugins in .ocra/config.json are not loaded for merge requests");
  }
  const code = new LocalGitAdapter({
    cwd,
    target: { mode: "range", from: refs.start_sha, to: refs.head_sha },
  });
  return {
    config,
    plugins: [],
    createVcs: (registry) =>
      registry.createVcs("gitlab", {
        project: /^\d+$/.test(project) ? Number(project) : project,
        iid: mr.iid,
        token,
        apiUrl,
        code,
        snapshot: merge,
        history: {
          filesChangedSince: (from: string, to: string) => filesChangedSince(root, from, to),
        },
        ...(fetchImpl ? { fetch: fetchImpl } : {}),
      }),
    readTrusted,
    publish: mr.publish,
    publishesTo: "merge request",
  };
}

// The project behind the origin remote: any host, since GitLab runs on many.
async function gitlabProject(root: string): Promise<string> {
  const url = await new LocalGitAdapter({ cwd: root, target: { mode: "workspace" } })
    .remoteUrl("origin")
    .catch(() => undefined);
  const match = url && /^(?:[\w+.-]+:\/\/[^/]+\/|[^@\s]+@[^:]+:)(.+?)(?:\.git)?\/?$/.exec(url);
  if (!match?.[1]) {
    throw new ConfigError("Cannot tell which GitLab project this is; pass --project <id|path>");
  }
  return match[1];
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
