import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { normaliseRemote } from "@open-cr-agent/cloud-contract";

// What a repository is called before it is salted and hashed for ocra Cloud
// (ADR-0028): `https://host/owner/repo`, the same for every way of writing
// its address, so a laptop cloning over SSH and CI cloning over HTTPS group
// their reviews and match the account's memory. It is the https form
// because 0.5.0 and earlier hashed the remote URL as written: an HTTPS
// clone, the common case and CI's, keeps its hash across the upgrade.

const run = promisify(execFile);

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
