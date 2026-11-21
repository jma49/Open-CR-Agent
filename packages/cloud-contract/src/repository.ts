// A repository's identity, the same for every way of writing its address,
// so a laptop cloning over SSH and CI cloning over HTTPS name it alike.

/** A repository as normaliseRemote names it. */
export const REPOSITORY_URL = /^https:\/\/[^/\s]+\/\S{1,500}$/;

// The WHATWG URL both Node.js and Workers provide; this package compiles
// without either's types.
declare const URL: new (url: string) => { protocol: string; hostname: string; pathname: string };

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
