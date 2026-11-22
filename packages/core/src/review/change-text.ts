import type { FileDiff } from "../domain.js";
import { data, join, ocraText, oneLine, type PromptText, section } from "./prompt-text.js";

// The change as one call reads it at a skim: every file's name and size, and
// as much of each patch as fits, smallest first, so one generated or
// vendored file cannot crowd out the rest of the change.
const MAX_FILE_PATCH_CHARS = 4_000;

export function changedFile(f: FileDiff): PromptText {
  const path = f.kind === "renamed" ? `${f.oldPath} -> ${f.newPath}` : f.newPath;
  return join(
    [ocraText(`${f.kind} `), data(oneLine(path)), ocraText(` (+${f.additions} -${f.deletions})`)],
    "",
  );
}

export function smallestPatchesFirst(files: readonly FileDiff[], maxChars: number): PromptText[] {
  let room = maxChars;
  const shown: PromptText[] = [];
  const bySize = [...files]
    .filter((f) => !f.isBinary && f.patch !== "")
    .sort((a, b) => a.patch.length - b.patch.length);
  for (const f of bySize) {
    const patch =
      f.patch.length > MAX_FILE_PATCH_CHARS
        ? join([data(f.patch.slice(0, MAX_FILE_PATCH_CHARS)), ocraText("[patch truncated]")])
        : data(f.patch);
    if (patch.length > room) continue;
    room -= patch.length;
    shown.push(section("diff", patch, { path: f.newPath }));
  }
  return shown;
}
