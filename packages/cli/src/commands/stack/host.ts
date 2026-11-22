import { githubStackHost } from "@open-cr-agent/vcs-github";
import { gitlabStackHost } from "@open-cr-agent/vcs-gitlab";
import type { StackHost } from "@open-cr-agent/vcs-platform";
import { type ProposalPlace, platformOf } from "../platform-place.js";
import type { ReviewDeps } from "../review/deps.js";
import { originUrl } from "../review/target.js";

export interface PlacedHost {
  host: StackHost;
  // How the platform links a change request's number in Markdown.
  sigil: "#" | "!";
}

export async function stackHost(
  root: string,
  named: ProposalPlace | undefined,
  deps: Pick<ReviewDeps, "env" | "fetch">,
  warn: (message: string) => void,
): Promise<PlacedHost> {
  const origin = () => originUrl(root);
  const place = named ?? platformOf(deps.env, await origin(), "ocra stack");
  const options = {
    env: deps.env,
    origin,
    ...(place.repository ? { repository: place.repository } : {}),
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
  };
  return place.platform === "gitlab"
    ? { host: await gitlabStackHost(options, warn), sigil: "!" }
    : { host: await githubStackHost(options), sigil: "#" };
}
