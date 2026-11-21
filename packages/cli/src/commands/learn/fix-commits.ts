import {
  fixCommits,
  isMinedPath,
  LocalGitAdapter,
  MAX_FIX_FILES,
} from "@open-cr-agent/vcs-local/internal";
import type { Candidate } from "./pipeline.js";

// Source 1 of ADR-0040: the fixes on HEAD's first-parent line, newest
// first. A fix of more source files than a defect usually spans is left out.
export async function fixCandidates(root: string): Promise<Candidate[]> {
  return (await fixCommits(root, "HEAD")).map((fix) => ({
    ref: fix.sha,
    evidence: async () => {
      const commit = new LocalGitAdapter({
        cwd: root,
        target: { mode: "commit", commit: fix.sha },
      });
      const [request, diff] = await Promise.all([commit.getChangeRequest(), commit.getDiff()]);
      const files = diff.filter((f) => isMinedPath(f.newPath));
      return {
        source: { kind: "fix-commit", ref: fix.sha },
        subject: request.title,
        message: request.description,
        files: files.length > MAX_FIX_FILES ? [] : files,
      };
    },
  }));
}
