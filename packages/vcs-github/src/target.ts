import { OcraError } from "@open-cr-agent/core";
import type { PlatformTarget, ResolveTargetOptions } from "@open-cr-agent/vcs-platform";
import { DEFAULT_BOT_LOGIN, pullRequestOf } from "./adapter.js";
import { GitHubApi } from "./client.js";

// The repository's `github` settings: who ocra comments as, and whether a
// blocking verdict requests changes.
export interface GitHubSettings {
  botLogin?: string;
  requestChanges?: boolean;
}

// A pull request on GitHub. GITHUB_TOKEN (or GH_TOKEN) is the credential,
// GITHUB_API_URL the API of GitHub Enterprise Server; the repository is
// --repo, else GITHUB_REPOSITORY, else origin's on github.com or that server.
// OCRA_CHECK_RUN_ID names an "ocra review" check run ocra Cloud queued.
export async function resolveGitHubTarget(
  options: ResolveTargetOptions,
): Promise<PlatformTarget<GitHubSettings>> {
  const { ref } = options;
  const { api, owner, repo, token, apiUrl } = await githubApi(options, ref.repository, "--pr");
  const fetchImpl = options.fetch;
  const signal = options.signal ? { signal: options.signal } : {};
  const pull = await api.getPullRequest(ref.number);
  const checkRunId = Number(options.env.OCRA_CHECK_RUN_ID);
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
        snapshot: pullRequestOf(pull, { owner, repo }),
        history: local.history,
        ...(local.merge ? { merge: local.merge } : {}),
        ...(Number.isSafeInteger(checkRunId) && checkRunId > 0 ? { checkRunId } : {}),
        ...(fetchImpl ? { fetch: fetchImpl } : {}),
        ...signal,
      }),
  };
}

type ApiOptions = Pick<ResolveTargetOptions, "env" | "origin" | "fetch" | "signal">;

// The API client for the repository named, else GITHUB_REPOSITORY's, else
// origin's; `what` names the command that needs the token.
export async function githubApi(options: ApiOptions, repository: string | undefined, what: string) {
  const { env } = options;
  const token = env.GITHUB_TOKEN ?? env.GH_TOKEN;
  if (!token) {
    throw new OcraError(
      "CONFIG_CREDENTIALS_MISSING",
      `${what} needs a GitHub token in GITHUB_TOKEN or GH_TOKEN`,
    );
  }
  const [owner = "", repo = ""] = (repository ?? (await repositoryName(options))).split("/");
  const apiUrl = env.GITHUB_API_URL;
  const api = new GitHubApi(
    { owner, repo },
    {
      token,
      ...(apiUrl ? { baseUrl: apiUrl } : {}),
      ...(options.fetch ? { fetch: options.fetch } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    },
  );
  return { api, owner, repo, token, apiUrl };
}

async function repositoryName(options: Pick<ApiOptions, "env" | "origin">): Promise<string> {
  if (options.env.GITHUB_REPOSITORY) return options.env.GITHUB_REPOSITORY;
  const url = await options.origin();
  const name = url
    ? githubHosts(options.env.GITHUB_API_URL)
        .map((host) => repositoryOn(host, url))
        .find(Boolean)
    : undefined;
  if (!name) {
    throw new OcraError(
      "CONFIG_INVALID",
      "Cannot tell which GitHub repository this is; pass --repo owner/name",
    );
  }
  return name;
}

// github.com, and the GitHub Enterprise Server whose API GITHUB_API_URL is.
function githubHosts(apiUrl: string | undefined): string[] {
  const server = apiUrl && URL.canParse(apiUrl) ? new URL(apiUrl).hostname : undefined;
  return server && server !== "api.github.com" ? ["github.com", server] : ["github.com"];
}

// `owner/name` of an HTTPS or SSH remote on `host`, any port.
function repositoryOn(host: string, url: string): string | undefined {
  const escaped = host.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(
    `(?:^|[@/.])${escaped}(?::\\d+)?[:/]([\\w.-]+/[\\w.-]+?)(?:\\.git)?/?$`,
    "i",
  );
  return pattern.exec(url)?.[1];
}
