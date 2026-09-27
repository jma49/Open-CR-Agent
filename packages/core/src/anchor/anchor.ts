import type { AnchorMethod, FileDiff, LineRange, ReportedFinding } from "../domain.js";
import { errorMessage } from "../errors.js";
import { exactMatchesInHunks, isWithinHunks, matchInContent, matchInHunks } from "./match.js";

export interface Anchor {
  file: string;
  method: AnchorMethod;
  lineRange?: LineRange;
  inDiff: boolean;
  // The quote fitted several places equally well, so no line was chosen.
  ambiguous?: true;
  warning?: string;
}

export interface RelocationRequest {
  file: string;
  snippet: string;
  body: string;
  patch: string;
}

export interface AnchorContext {
  diffs: readonly FileDiff[];
  readNewFile(path: string): Promise<string | undefined>;
  relocate?(request: RelocationRequest): Promise<string | undefined>;
}

type AnchorInput = Pick<ReportedFinding, "file" | "existingCode" | "body">;

export async function anchorFinding(finding: AnchorInput, ctx: AnchorContext): Promise<Anchor> {
  const own = ctx.diffs.find((d) => d.newPath === finding.file);

  if (own) {
    const found = await locateInFile(own, finding.existingCode, ctx, "hunk", "file");
    if (found) return found;
  }

  // The model may have named the wrong file: accept another file's lines only
  // for an exact quote that appears nowhere else.
  const elsewhere = exactMatchesInHunks(
    ctx.diffs.filter((d) => d !== own),
    finding.existingCode,
  );
  if (elsewhere.length === 1) {
    const [match] = elsewhere as [(typeof elsewhere)[number]];
    return { file: match.file, method: "cross_file", lineRange: match.range, inDiff: true };
  }

  if (own && ctx.relocate) {
    let snippet: string | undefined;
    try {
      snippet = await ctx.relocate({
        file: own.newPath,
        snippet: finding.existingCode,
        body: finding.body,
        patch: own.patch,
      });
    } catch (error) {
      return fileLevel(finding.file, `relocation failed: ${errorMessage(error)}`);
    }
    const found = snippet && (await locateInFile(own, snippet, ctx, "relocated", "relocated"));
    if (found) return found;
  }

  return fileLevel(finding.file);
}

// An ambiguous quote stops the search in its own file: looking further (the
// whole file, other files) would only find more places.
async function locateInFile(
  diff: FileDiff,
  snippet: string,
  ctx: AnchorContext,
  hunkMethod: AnchorMethod,
  fileMethod: AnchorMethod,
): Promise<Anchor | undefined> {
  const inHunk = matchInHunks(diff, snippet);
  if (inHunk.kind === "found") {
    return { file: diff.newPath, method: hunkMethod, lineRange: inHunk.range, inDiff: true };
  }
  if (inHunk.kind === "ambiguous") return ambiguous(diff.newPath);

  const content = await ctx.readNewFile(diff.newPath);
  const inFile = content === undefined ? undefined : matchInContent(content, snippet);
  if (inFile?.kind === "ambiguous") return ambiguous(diff.newPath);
  if (inFile?.kind !== "found") return undefined;
  return {
    file: diff.newPath,
    method: fileMethod,
    lineRange: inFile.range,
    inDiff: isWithinHunks(diff, inFile.range),
  };
}

function ambiguous(file: string): Anchor {
  return { file, method: "file_level", inDiff: false, ambiguous: true };
}

function fileLevel(file: string, warning?: string): Anchor {
  return warning === undefined
    ? { file, method: "file_level", inDiff: false }
    : { file, method: "file_level", inDiff: false, warning };
}
