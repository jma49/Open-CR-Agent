import { execFile } from "node:child_process";
import { promisify } from "node:util";

// What a repository is called before it is salted and hashed for ocra Cloud
// (ADR-0028): `https://host/owner/repo`, the same for every way of writing
// its address, so a laptop cloning over SSH and CI cloning over HTTPS group
// their reviews and match the account's memory. It is the https form
// because 0.5.0 and earlier hashed the remote URL as written: an HTTPS
// clone, the common case and CI's, keeps its hash across the upgrade.

const run = promisify(execFile);

// Hosts that serve SSH for another host's repositories (port 443 fallbacks).
const SSH_ALIASES: Record<string, string> = {
  "ssh.github.com": "github.com",
  "altssh.gitlab.com": "gitlab.com",
};

/**
 * `https://host/owner/repo` for a remote in URL form (`https://`,
 * `ssh://`, `git://`) or scp form (`user@host:owner/repo`), without user,
 * password, port, trailing `/` or `.git`, case-folded; undefined for a
 * local path.
 */
export function normaliseRemote(url: string): string | undefined {
  const parsed = hostAndPath(url.trim());
  if (!parsed) return undefined;
  const host = parsed.host.toLowerCase();
  const path = parsed.path
    .replace(/^\/+|\/+$/g, "")
    .replace(/\.git$/i, "")
    .replace(/\/+$/, "");
  if (!host || !path) return undefined;
  return `https://${SSH_ALIASES[host] ?? host}/${path}`.toLowerCase();
}

/** The repository behind a pull or merge request's web page, such as https://host/o/r/pull/7. */
export function repositoryOfWebUrl(url: string): string | undefined {
  const page = /^(.+?)\/(?:-\/)?(?:pull|merge_requests)\/\d+\/?$/.exec(url.trim());
  return page?.[1] ? normaliseRemote(page[1]) : undefined;
}

/** The repository behind origin; its address as written when it is a path, the root without one. */
export async function originRepository(root: string): Promise<string> {
  let url: string;
  try {
    const { stdout } = await run("git", ["-C", root, "remote", "get-url", "origin"], {
      timeout: 10_000,
    });
    url = stdout.trim();
  } catch {
    return root;
  }
  return normaliseRemote(url) ?? url.toLowerCase();
}

function hostAndPath(url: string): { host: string; path: string } | undefined {
  if (/^[a-z][\w+.-]*:\/\//i.test(url)) {
    try {
      const parsed = new URL(url);
      if (parsed.protocol === "file:") return undefined;
      return { host: parsed.hostname, path: decodeURIComponent(parsed.pathname) };
    } catch {
      return undefined;
    }
  }
  // scp form; a Windows path such as C:\repo or C:/repo, whose "host" is
  // one letter, is not one.
  const scp = /^(?:[^@\s/]+@)?([^:/\s\\]+):(.+)$/.exec(url);
  if (!scp?.[1] || !scp[2] || scp[1].length === 1) return undefined;
  return { host: scp[1], path: scp[2] };
}
