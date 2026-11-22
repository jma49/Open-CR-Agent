import { LEARNING_PROPOSAL_BRANCH, LEARNINGS_DIR } from "@open-cr-agent/cloud-contract";
import type { LearningDraft } from "@open-cr-agent/core/internal";
import { proposeOnGitHub } from "@open-cr-agent/vcs-github";
import { proposeOnGitLab } from "@open-cr-agent/vcs-gitlab";
import type { ProposedChange } from "@open-cr-agent/vcs-platform";
import { safeMarkdown } from "@open-cr-agent/vcs-platform/internal";
import { type ProposalPlace, platformOf } from "../platform-place.js";
import type { ReviewDeps } from "../review/deps.js";
import type { ResolvedRun } from "../review/resolve-run.js";
import { originUrl } from "../review/target.js";
import { freeLearningPath, learningFile } from "./write.js";

export interface Proposed extends ProposedChange {
  platform: ProposalPlace["platform"];
}

// Write-back by pull request (ADR-0040): merged once its checks pass,
// unless the configuration's learnings.requireReview or --require-review
// leaves it to a person.
export async function proposeLearnings(
  run: ResolvedRun,
  kept: readonly LearningDraft[],
  created: string,
  deps: Pick<ReviewDeps, "env" | "fetch" | "now">,
  // What they were drafted from, for the title: "fix commits".
  from: string,
  options: {
    named?: ProposalPlace | undefined;
    requireReview?: boolean;
    // Paths other proposals hold: the same name would conflict when both merge.
    taken?: readonly string[];
  } = {},
): Promise<Proposed> {
  const { named } = options;
  const taken = new Set([
    ...(await run.target.trusted.listFiles(LEARNINGS_DIR)),
    ...(options.taken ?? []),
  ]);
  const files = kept.map((draft) => {
    const path = freeLearningPath(draft.title, taken);
    taken.add(path);
    return { path, content: learningFile(draft, created), draft };
  });
  const stamp = new Date(deps.now()).toISOString().replace(/\D/g, "").slice(0, 14);
  const origin = () => originUrl(run.root);
  const place = named ?? platformOf(deps.env, await origin(), "--propose");
  const propose = place.platform === "gitlab" ? proposeOnGitLab : proposeOnGitHub;
  const proposed = await propose(
    {
      env: deps.env,
      ...(place.repository ? { repository: place.repository } : {}),
      origin,
      ...(deps.fetch ? { fetch: deps.fetch } : {}),
      signal: run.interrupt.signal,
    },
    {
      branch: `${LEARNING_PROPOSAL_BRANCH}${stamp}`,
      title: `chore(ocra): add ${files.length} learning(s) from ${from}`,
      commitMessage: `chore(ocra): add ${files.length} learning(s) from ${from}`,
      body: [
        `Learnings \`ocra learn\` drafted from this repository's ${from}. Each one is given to the reviews of changes it applies to; edit or delete any that is wrong.`,
        "",
        ...files.map(
          (f) =>
            `- \`${f.path}\`: ${safeMarkdown(f.draft.title)} (from ${f.draft.source.ref ?? f.draft.source.kind})`,
        ),
      ].join("\n"),
      files: files.map(({ path, content }) => ({ path, content })),
      autoMerge: run.config.learnings.requireReview !== true && options.requireReview !== true,
    },
  );
  return { ...proposed, platform: place.platform };
}
