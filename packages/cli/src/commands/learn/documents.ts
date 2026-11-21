import { readFile, realpath, stat } from "node:fs/promises";
import { relative, resolve } from "node:path";
import type { FileDiff } from "@open-cr-agent/core";
import { UsageError } from "../../io/usage-error.js";
import type { TrustedTree } from "../review/target.js";
import { unchanged } from "./evidence.js";
import type { Candidate } from "./pipeline.js";

const MAX_DOCUMENT_BYTES = 256 * 1024;
// Files a section names that are read for its evidence.
const MAX_NAMED_FILES = 5;
const MAX_TRIED = 20;
const MAX_FILE_CHARS = 4_000;
export const PATH_LIKE = /(?<![\w./-])(?:[\w@.-]+\/)+[\w@.-]+(?![\w/-])/g;

// The document source of ADR-0040: each `##` section of the Markdown documents named,
// with the files of the repository it names. A section naming none holds
// nothing a review of a change could be given, so it is not drafted.
export async function documentCandidates(
  root: string,
  documents: readonly string[],
  tree: TrustedTree,
): Promise<Candidate[]> {
  if (documents.length === 0) throw new UsageError("ocra learn import needs a document");
  const candidates: Candidate[] = [];
  const realRoot = await realpath(root);
  for (const document of documents) {
    const path = resolve(root, document);
    if ((await stat(path)).size > MAX_DOCUMENT_BYTES) {
      throw new UsageError(`${document} is larger than ${MAX_DOCUMENT_BYTES} bytes`);
    }
    const name = relative(realRoot, await realpath(path))
      .split("\\")
      .join("/");
    for (const section of sectionsOf(await readFile(path, "utf8"))) {
      candidates.push({
        ref: `${name}#${section.slug}`,
        evidence: async () => ({
          kind: "document",
          source: { kind: "document", ref: `${name}#${section.slug}` },
          subject: section.heading,
          message: section.text,
          files: await namedFiles(section.text, tree),
        }),
      });
    }
  }
  return candidates;
}

interface Section {
  heading: string;
  slug: string;
  text: string;
}

// The text before the first `##` heading is the document's introduction,
// a section of its own under the document's title.
export function sectionsOf(markdown: string): Section[] {
  const sections: Section[] = [];
  const slugs = new Map<string, number>();
  let heading = /^#\s+(.+)$/m.exec(markdown)?.[1]?.trim() ?? "Introduction";
  let lines: string[] = [];
  let fenced = false;
  const flush = () => {
    const text = lines.join("\n").trim();
    if (text !== "") sections.push({ heading, slug: slugOf(heading, slugs), text });
    lines = [];
  };
  for (const line of markdown.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    const next = fenced ? undefined : /^##\s+(.+)$/.exec(line)?.[1];
    if (next === undefined) {
      if (!/^#\s/.test(line) || fenced) lines.push(line);
      continue;
    }
    flush();
    heading = next.trim();
  }
  flush();
  return sections;
}

function slugOf(heading: string, slugs: Map<string, number>): string {
  const base =
    heading
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, "-")
      .replace(/^-+|-+$/g, "") || "section";
  const seen = (slugs.get(base) ?? 0) + 1;
  slugs.set(base, seen);
  return seen === 1 ? base : `${base}-${seen}`;
}

// The files the text names that exist at the trusted revision, as the
// unchanged lines of a diff, so a draft's symbols are checked against them.
async function namedFiles(text: string, tree: TrustedTree): Promise<FileDiff[]> {
  const files: FileDiff[] = [];
  const named = new Set((text.match(PATH_LIKE) ?? []).map((p) => p.replace(/^\.\//, "")));
  for (const path of [...named].slice(0, MAX_TRIED)) {
    if (files.length >= MAX_NAMED_FILES) break;
    const content = await tree.readFile(path);
    if (content !== undefined) files.push(unchanged(path, content, MAX_FILE_CHARS));
  }
  return files;
}
