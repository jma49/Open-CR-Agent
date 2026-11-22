import { OcraError } from "@open-cr-agent/core";
import type { ReviewDeps } from "./review/deps.js";

// Where a command opens or finds change requests of its own.
export interface ProposalPlace {
  platform: "github" | "gitlab";
  repository?: string;
}

// The platform no flag named: the CI it runs in, else origin's host, else
// the one platform a token is set for; `what` names the command that asks.
export function platformOf(
  env: ReviewDeps["env"],
  origin: string | undefined,
  what: string,
): ProposalPlace {
  if (env.GITLAB_CI) return { platform: "gitlab" };
  if (env.GITHUB_ACTIONS) return { platform: "github" };
  if (origin && /(?:^|[@/.])github\.com[:/]/i.test(origin)) return { platform: "github" };
  if (origin && /(?:^|[@/.])gitlab\.com[:/]/i.test(origin)) return { platform: "gitlab" };
  const github = Boolean(env.GITHUB_TOKEN ?? env.GH_TOKEN);
  const gitlab = Boolean(env.GITLAB_TOKEN);
  if (github !== gitlab) return { platform: github ? "github" : "gitlab" };
  throw new OcraError(
    "CONFIG_INVALID",
    `Cannot tell whether ${what} works on GitHub pull requests or GitLab merge requests; pass --repo <owner/name> or --project <id|path>`,
  );
}
