import type { FileDiff, VcsAdapter } from "@open-cr-agent/core";
import { MAX_FIX_FILES } from "@open-cr-agent/vcs-local/internal";
import { PATH_LIKE } from "./documents.js";
import type { Candidate } from "./pipeline.js";

// The remember source of ADR-0040: each `@ocra remember <note>` on the pull
// or merge request, with the files it is about: those of the diff the note
// names, else the whole diff when it is as small as a fix.
export async function rememberedCandidates(vcs: VcsAdapter): Promise<Candidate[]> {
  const change = await vcs.getChangeRequest();
  const notes = change.remember ?? [];
  if (notes.length === 0) return [];
  const diff = (await vcs.getDiff()).filter((f) => !f.isBinary);
  return notes.map((note) => ({
    ref: note.ref,
    evidence: async () => ({
      kind: "remember",
      source: { kind: "remember", ref: note.ref },
      subject: change.title,
      message: note.note,
      files: filesOf(note.note, diff),
    }),
  }));
}

function filesOf(note: string, diff: readonly FileDiff[]): FileDiff[] {
  const named = new Set((note.match(PATH_LIKE) ?? []).map((p) => p.replace(/^\.\//, "")));
  const mentioned = diff.filter((f) => named.has(f.newPath));
  if (mentioned.length > 0) return mentioned;
  return diff.length <= MAX_FIX_FILES ? [...diff] : [];
}
