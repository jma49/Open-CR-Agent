import { OcraError } from "@open-cr-agent/core";
import type { PlatformTarget, ResolveTargetOptions } from "@open-cr-agent/vcs-platform";
import { DEFAULT_BOT_LOGIN } from "./adapter.js";
import { GitHubApi } from "./client.js";

// The repository's `github` settings: who ocra comments as, and whether a
// blocking verdict requests changes.
export interface GitHubSettings {
  botLogin?: string;
  requestChanges?: boolean;
}

// A pull request on GitHub. GITHUB_TOKEN (or GH_TOKEN) is the credential,
// GITHUB_API_URL the API of GitHub Enterprise Server; the repository is
// --repo, else GITHUB_REPOSITORY, else origin's.
export async function resolveGitHubTarget(
  options: ResolveTargetOptions,
): Promise<PlatformTarget<GitHubSettings>> {
  const { env, ref } = options;
  const token = env.GITHUB_TOKEN ?? env.GH_TOKEN;
  if (!token) {
    throw new OcraError(
      "CONFIG_CREDENTIALS_MISSING",
      "--pr needs a GitHub token in GITHUB_TOKEN or GH_TOKEN",
    );
  }
  const [owner = "", repo = ""] = (ref.repository ?? (await repositoryName(options))).split("/");
  const apiUrl = env.GITHUB_API_URL;
  const fetchImpl = options.fetch;
  const api = new GitHubApi(
    { owner, repo },
    {
      token,
      ...(apiUrl ? { baseUrl: apiUrl } : {}),
      ...(fetchImpl ? { fetch: fetchImpl } : {}),
    },
  );
  const pull = await api.getPullRequest(ref.number);
  return {
    platform: "github",
    baseSha: pull.base.sha,
    headSha: pull.head.sha,
    headRefs: [`pull/${ref.number}/head`],
    webUrl: pull.html_url,
    createVcs: (registry, local, settings) =>
      registry.createVcs("github", {
        owner,
        repo,
        number: ref.number,
        token,
        ...(apiUrl ? { apiUrl } : {}),
        botLogin: settings.botLogin ?? DEFAULT_BOT_LOGIN,
        requestChanges: settings.requestChanges ?? false,
        code: local.code,
        snapshot: pull,
        history: local.history,
        ...(fetchImpl ? { fetch: fetchImpl } : {}),
      }),
  };
}

async function repositoryName(options: ResolveTargetOptions): Promise<string> {
  if (options.env.GITHUB_REPOSITORY) return options.env.GITHUB_REPOSITORY;
  const url = await options.origin();
  const match = url && /github\.com[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?$/.exec(url);
  if (!match?.[1]) {
    throw new OcraError(
      "CONFIG_INVALID",
      "Cannot tell which GitHub repository this is; pass --repo owner/name",
    );
  }
  return match[1];
}
