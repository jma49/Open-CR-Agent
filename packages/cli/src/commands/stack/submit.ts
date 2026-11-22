import { OcraError } from "@open-cr-agent/core";
import type { StackedChangeRequest } from "@open-cr-agent/vcs-platform";
import type { StackGit } from "./git.js";
import type { PlacedHost } from "./host.js";
import type { StackLinks } from "./links.js";
import { stackSection, withStackSection } from "./section.js";

export interface Submitted {
  branch: string;
  number: number;
  webUrl: string;
  action: "opened" | "updated" | "unchanged";
}

// Pushes every branch and gives each one an open change request based on
// its parent, then writes the stack's list into every description
// (ADR-0053). A branch whose change request merged stops it before anything
// is pushed: sync first.
export async function submit(
  git: StackGit,
  { host, sigil }: PlacedHost,
  links: StackLinks,
  order: readonly string[],
  options: { trunk: string; draft: boolean },
): Promise<Submitted[]> {
  const found = new Map<string, StackedChangeRequest | undefined>();
  for (const branch of order) {
    const request = await host.find(branch);
    if (request?.state === "merged") {
      throw new OcraError(
        "INPUT_USAGE",
        `${branch}'s change request ${sigil}${request.number} merged; run ocra stack sync first`,
      );
    }
    found.set(branch, request);
  }
  const requests: { branch: string; request: StackedChangeRequest; opened: boolean }[] = [];
  for (const branch of order) {
    const link = links.get(branch);
    if (!link) continue;
    await git.run([
      "push",
      "--quiet",
      `--force-with-lease=refs/heads/${branch}`,
      "origin",
      `refs/heads/${branch}:refs/heads/${branch}`,
    ]);
    const existing = found.get(branch);
    if (existing) {
      requests.push({ branch, request: existing, opened: false });
      continue;
    }
    const title = await git.run([
      "log",
      "--reverse",
      "--format=%s",
      `${link.parentHead}..refs/heads/${branch}`,
    ]);
    const opened = await host.open({
      head: branch,
      base: link.parent,
      title: title.split("\n")[0] || branch,
      body: "",
      draft: options.draft,
    });
    requests.push({ branch, request: opened, opened: true });
  }
  const entries = requests.map(({ request }) => ({ number: request.number, title: request.title }));
  const submitted: Submitted[] = [];
  for (const { branch, request, opened } of requests) {
    const base = links.get(branch)?.parent ?? options.trunk;
    const body = withStackSection(request.body, stackSection(entries, request.number, sigil));
    const change = {
      ...(request.base !== base ? { base } : {}),
      ...(request.body !== body ? { body } : {}),
    };
    const changed = Object.keys(change).length > 0;
    if (changed) await host.update(request.number, change);
    submitted.push({
      branch,
      number: request.number,
      webUrl: request.webUrl,
      action: opened ? "opened" : changed ? "updated" : "unchanged",
    });
  }
  return submitted;
}
