import { errorMessage, type Learning } from "@open-cr-agent/core";
import { mapWithConcurrency } from "@open-cr-agent/core/internal";
import { fetchRemoteBranches, LocalGitAdapter } from "@open-cr-agent/vcs-local/internal";
import { loadLearnings } from "../review/learnings.js";
import { originUrl } from "../review/target.js";
import { PROPOSAL_BRANCH } from "./propose.js";

const MAX_PROPOSALS = 20;
const READ_CONCURRENCY = 4;

// The learnings on origin's proposal branches: an open proposal, or one a
// person closed without merging, whose lessons the next run must not
// draft again. Only deduplication reads them; no review is given them.
export async function proposedLearnings(
  root: string,
  warn: (message: string) => void,
): Promise<Learning[]> {
  if ((await originUrl(root)) === undefined) return [];
  try {
    const branches = await fetchRemoteBranches(root, PROPOSAL_BRANCH, { max: MAX_PROPOSALS });
    const loaded = await mapWithConcurrency(branches, READ_CONCURRENCY, (branch) =>
      loadLearnings(
        new LocalGitAdapter({ cwd: root, target: { mode: "commit", commit: branch.sha } }),
        () => {},
      ),
    );
    return loaded.flat();
  } catch (error) {
    warn(
      `the proposals on origin could not be read, so a lesson waiting in one may be drafted again: ${errorMessage(error)}`,
    );
    return [];
  }
}
