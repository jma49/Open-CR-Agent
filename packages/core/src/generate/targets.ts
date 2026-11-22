import type { FileDiff } from "../domain.js";
import { isTestFile, type Language, languageOf } from "./languages.js";

export type GenerateKind = "tests" | "docstrings";

export const MAX_TARGETS = 5;

export interface Target {
  diff: FileDiff;
  language: Language;
  // Its mode at the head, which an edit keeps.
  executable: boolean;
}

export interface Skipped {
  path: string;
  reason: string;
}

// The changed source files ocra writes for, from the files a review would
// select (which already leaves out secrets, generated and vendored files):
// regular files of code in a supported language with added lines, never a
// test, most added lines first, at most MAX_TARGETS.
export function generationTargets(
  kind: GenerateKind,
  selected: readonly FileDiff[],
): { targets: Target[]; skipped: Skipped[] } {
  const candidates = selected
    .filter((d) => !d.isBinary && d.kind !== "deleted" && d.additions > 0)
    .filter((d) => !isTestFile(d.newPath))
    .flatMap((diff) => {
      const language = languageOf(diff.newPath);
      const mode = headMode(diff) ?? "100644";
      if (!language || (kind === "tests" && !language.tests)) return [];
      if (mode !== "100644" && mode !== "100755") return [];
      return [{ diff, language, executable: mode === "100755" }];
    })
    .sort(
      (a, b) => b.diff.additions - a.diff.additions || a.diff.newPath.localeCompare(b.diff.newPath),
    );
  return {
    targets: candidates.slice(0, MAX_TARGETS),
    skipped: candidates.slice(MAX_TARGETS).map((t) => ({
      path: t.diff.newPath,
      reason: `over the limit of ${MAX_TARGETS} files a run writes for`,
    })),
  };
}

// From git's extended header, when it says: a symbolic link (120000) or a
// submodule (160000) reads as a path or a commit id, never as code to edit.
function headMode(diff: FileDiff): string | undefined {
  const header = diff.patch.split("\n@@")[0] ?? "";
  return (
    /^new (?:file )?mode (\d{6})$/m.exec(header)?.[1] ??
    /^index [0-9a-f]+\.\.[0-9a-f]+ (\d{6})$/m.exec(header)?.[1]
  );
}
