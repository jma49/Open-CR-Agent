import { OcraError } from "@open-cr-agent/core";
import type { PlatformTarget, ResolveTargetOptions } from "@open-cr-agent/vcs-platform";
import { mergeRequestOf } from "./adapter.js";
import { GitLabApi } from "./client.js";

const GITLAB_API = "https://gitlab.com/api/v4";

// GitLab has no repository settings in .ocra/config.json yet.
export type GitLabSettings = Record<string, never>;

// A merge request on GitLab. GitLab CI sets CI_API_V4_URL and
// CI_PROJECT_ID; GITLAB_TOKEN must be a token that may write notes, which
// CI_JOB_TOKEN may not. The project is --project, else CI_PROJECT_ID, else
// origin's.
export async function resolveGitLabTarget(
  options: ResolveTargetOptions,
): Promise<PlatformTarget<GitLabSettings>> {
  const { ref } = options;
  const { api, project, token, apiUrl } = await gitlabApi(options, ref.repository, "--mr");
  const fetchImpl = options.fetch;
  const signal = options.signal ? { signal: options.signal } : {};
  const iid = ref.number;
  const merge = await api.getMergeRequest(iid);
  const snapshot = mergeRequestOf(merge);
  return {
    platform: "gitlab",
    baseSha: snapshot.baseSha,
    headSha: snapshot.headSha,
    headRefs: [`refs/merge-requests/${iid}/head`],
    webUrl: merge.web_url,
    createVcs: (registry, local) =>
      registry.createVcs("gitlab", {
        project: /^\d+$/.test(project) ? Number(project) : project,
        iid,
        token,
        apiUrl,
        code: local.code,
        snapshot,
        history: local.history,
        ...(local.merge ? { merge: local.merge } : {}),
        ...(fetchImpl ? { fetch: fetchImpl } : {}),
        ...signal,
      }),
  };
}

type ApiOptions = Pick<ResolveTargetOptions, "env" | "origin" | "fetch" | "signal" | "warn">;

// The API client for the project named, else CI_PROJECT_ID's, else origin's.
// `what` is the flag that needs it, for the error without a token.
export async function gitlabApi(options: ApiOptions, named: string | undefined, what: string) {
  const { env } = options;
  const token = env.GITLAB_TOKEN;
  if (!token) {
    throw new OcraError(
      "CONFIG_CREDENTIALS_MISSING",
      `${what} needs a GitLab token in GITLAB_TOKEN with the api scope and the Developer role: a project access token, or on GitLab.com Free a personal access token of a dedicated account (CI_JOB_TOKEN cannot post comments)`,
    );
  }
  const origin = await options.origin();
  const apiUrl = gitlabApiUrl(env.CI_API_V4_URL, remoteHost(origin), options.warn);
  const project = named ?? env.CI_PROJECT_ID ?? gitlabProject(origin, apiUrl);
  const api = new GitLabApi(project, {
    token,
    baseUrl: apiUrl,
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  });
  return { api, project, token, apiUrl };
}

// Where GITLAB_TOKEN goes: to CI_API_V4_URL, which GitLab CI sets, or else
// to gitlab.com, but only when origin is there too or is no remote host. A
// token for a self-managed instance must not travel to gitlab.com because
// the address was left out.
function gitlabApiUrl(
  configured: string | undefined,
  origin: string | undefined,
  warn: (message: string) => void,
): string {
  if (configured) {
    const api = remoteHost(configured);
    if (api && origin && site(api) !== site(origin)) {
      warn(`CI_API_V4_URL is on ${api} but origin is on ${origin}; GITLAB_TOKEN goes to ${api}`);
    }
    return configured;
  }
  if (origin && site(origin) !== "gitlab.com") {
    throw new OcraError(
      "CONFIG_INVALID",
      `origin is on ${origin}, not gitlab.com: set CI_API_V4_URL to its API, such as https://${origin}/api/v4, so that GITLAB_TOKEN goes only there`,
    );
  }
  return GITLAB_API;
}

// GitLab.com answers on subdomains too, such as altssh.gitlab.com for SSH.
function site(host: string): string {
  return host === "gitlab.com" || host.endsWith(".gitlab.com") ? "gitlab.com" : host;
}

// The host of https://host/…, ssh://user@host:port/… or user@host:path; none
// for a local path, including C:\ on Windows.
function remoteHost(url: string | undefined): string | undefined {
  if (!url) return undefined;
  if (/^[\w+.-]+:\/\//.test(url)) {
    try {
      const parsed = new URL(url);
      return parsed.protocol === "file:" ? undefined : parsed.hostname.toLowerCase() || undefined;
    } catch {
      return undefined;
    }
  }
  return /^(?:[^@\s/]+@)?([^:/\s\\]+):(?![\\/])/.exec(url)?.[1]?.toLowerCase();
}

// The project behind the origin remote: any host, since GitLab runs on many.
// An HTTPS remote of an instance installed under a relative URL root
// (https://example.com/gitlab/group/project) has the API's root before it.
function gitlabProject(url: string | undefined, apiUrl: string): string {
  const match = url && /^(?:[\w+.-]+:\/\/[^/]+\/|[^@\s]+@[^:]+:)(.+?)(?:\.git)?\/?$/.exec(url);
  if (!url || !match?.[1]) {
    throw new OcraError(
      "CONFIG_INVALID",
      "Cannot tell which GitLab project this is; pass --project <id|path>",
    );
  }
  const root = new URL(apiUrl).pathname.replace(/\/api\/v4\/?$/, "").replace(/^\/+/, "");
  const underRoot = root && /^[\w+.-]+:\/\//.test(url) && match[1].startsWith(`${root}/`);
  return underRoot ? match[1].slice(root.length + 1) : match[1];
}
