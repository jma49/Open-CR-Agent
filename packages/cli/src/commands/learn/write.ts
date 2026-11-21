import { LEARNINGS_DIR } from "@open-cr-agent/cloud-contract";
import type { LearningDraft } from "@open-cr-agent/core/internal";
import { stringify } from "yaml";
import { writeRepositoryFile } from "../../io/repository-file.js";
import { parseLearning } from "../review/learnings.js";

const MAX_SLUG = 60;
const MAX_SUFFIX = 50;

// The learning as a file of the contract's format (ADR-0037), or why it
// is not one: what is written is what a review will read back.
export function learningFile(draft: LearningDraft, created: string): string {
  const frontmatter = {
    title: draft.title,
    paths: draft.paths,
    ...(draft.symbols.length > 0 ? { symbols: draft.symbols } : {}),
    ...(draft.keywords.length > 0 ? { keywords: draft.keywords } : {}),
    source: { kind: draft.source.kind, ...(draft.source.ref ? { ref: draft.source.ref } : {}) },
    created,
  };
  const text = `---\n${stringify(frontmatter, { lineWidth: 0 })}---\n\n${draft.body}\n`;
  const parsed = parseLearning(text);
  if (typeof parsed === "string") throw new Error(`the drafted learning is invalid: ${parsed}`);
  return text;
}

// Named after its title; a name already taken gets a number, decided by
// the file system's exclusive create rather than a look beforehand.
export async function writeLearning(root: string, text: string, title: string): Promise<string> {
  const slug = slugOf(title);
  for (let n = 1; n <= MAX_SUFFIX; n++) {
    const id = n === 1 ? slug : `${slug.slice(0, MAX_SLUG - 3)}-${n}`;
    const path = `${LEARNINGS_DIR}/${id}.md`;
    if ((await writeRepositoryFile(root, path, text, { replace: false })) === "written")
      return path;
  }
  throw new Error(`${MAX_SUFFIX} learnings are already named after "${slug}"`);
}

function slugOf(title: string): string {
  const slug = title
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, MAX_SLUG)
    .replace(/^-+|-+$/g, "");
  return slug === "" ? "learning" : slug;
}
