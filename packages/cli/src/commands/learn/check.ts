import { unmatchedPaths } from "@open-cr-agent/core/internal";
import { revisionFiles } from "@open-cr-agent/vcs-local/internal";
import { EXIT } from "../../io/exit.js";
import { forTerminal } from "../../io/terminal.js";
import type { ResolvedRun, ReviewIo } from "../review/resolve-run.js";

// Learnings whose paths name no file at HEAD: a module moved or was
// renamed, and reviews no longer give them by those paths. No model call.
export async function checkLearnings(run: ResolvedRun, io: ReviewIo): Promise<number> {
  const files = (await revisionFiles(run.root, "HEAD")).map((f) => f.path);
  const unmatched = unmatchedPaths(run.learnings, files);
  for (const { id, paths } of unmatched) {
    io.out.write(`${forTerminal(`${id}: no file matches ${paths.join(", ")}`)}\n`);
  }
  io.err.write(
    unmatched.length === 0
      ? `[ocra] every path of the ${run.learnings.length} learning(s) matches a file\n`
      : `[ocra] ${unmatched.length} of ${run.learnings.length} learning(s) name paths that match no file; edit their paths\n`,
  );
  return unmatched.length === 0 ? EXIT.ok : EXIT.blocking;
}
