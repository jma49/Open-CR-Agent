import { LEARNINGS_DIR } from "@open-cr-agent/cloud-contract";
import type { LearningDraft } from "@open-cr-agent/core/internal";
import { proposeOnGitHub } from "@open-cr-agent/vcs-github";
import type { ProposedChange } from "@open-cr-agent/vcs-platform";
import { safeMarkdown } from "@open-cr-agent/vcs-platform/internal";
import type { ReviewDeps } from "../review/deps.js";
import type { ResolvedRun } from "../review/resolve-run.js";
import { originUrl } from "../review/target.js";
import { freeLearningPath, learningFile } from "./write.js";

// Write-back by pull request (ADR-0040): merged once its checks pass,
// unless the configuration's learnings.requireReview leaves it to a person.
export async function proposeLearnings(
  run: ResolvedRun,
  kept: readonly LearningDraft[],
  created: string,
  deps: Pick<ReviewDeps, "env" | "fetch" | "now">,
  // What they were drafted from, for the title: "fix commits".
  from: string,
): Promise<ProposedChange> {
  const taken = new Set(await run.target.trusted.listFiles(LEARNINGS_DIR));
  const files = kept.map((draft) => {
    const path = freeLearningPath(draft.title, taken);
    taken.add(path);
    return { path, content: learningFile(draft, created), draft };
  });
  const stamp = new Date(deps.now()).toISOString().replace(/\D/g, "").slice(0, 14);
  return proposeOnGitHub(
    {
      env: deps.env,
      origin: () => originUrl(run.root),
      ...(deps.fetch ? { fetch: deps.fetch } : {}),
      signal: run.interrupt.signal,
    },
    {
      branch: `ocra/learnings-${stamp}`,
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
      autoMerge: run.config.learnings.requireReview !== true,
    },
  );
}
