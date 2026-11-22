import { posix } from "node:path";
import type { ProjectDoc } from "@open-cr-agent/core";
import { mapWithConcurrency } from "@open-cr-agent/core/internal";
import type { TrustedTree } from "./target.js";

export const PROJECT_DOC_FILE_LIMITS = { files: 50, bytes: 200_000 } as const;
const READ_CONCURRENCY = 8;
const MARKDOWN = /\.mdx?$/i;

// The documents `projectDocs` names, from the trusted revision: a Markdown
// file as named, a directory's Markdown files directly in it, by name. A
// path that is missing, too large or outside the repository costs that
// document and a warning, never the review (ADR-0052).
export async function loadProjectDocs(
  entries: readonly string[],
  tree: TrustedTree,
  warn: (message: string) => void,
): Promise<ProjectDoc[]> {
  const paths: string[] = [];
  for (const entry of entries) {
    const path = posix.normalize(entry).replace(/\/$/, "");
    if (path === ".." || path.startsWith("../") || posix.isAbsolute(path)) {
      warn(`projectDocs: ${entry} is outside the repository`);
      continue;
    }
    const found = MARKDOWN.test(path)
      ? [path]
      : (await tree.listFiles(path)).filter((p) => MARKDOWN.test(p)).sort();
    if (found.length === 0) warn(`projectDocs: ${entry} holds no Markdown file`);
    for (const p of found) if (!paths.includes(p)) paths.push(p);
  }
  if (paths.length > PROJECT_DOC_FILE_LIMITS.files) {
    warn(
      `projectDocs names ${paths.length} documents; only the first ${PROJECT_DOC_FILE_LIMITS.files} are read`,
    );
  }
  const docs = await mapWithConcurrency(
    paths.slice(0, PROJECT_DOC_FILE_LIMITS.files),
    READ_CONCURRENCY,
    async (path): Promise<ProjectDoc | undefined> => {
      const text = await tree.readFile(path);
      if (text === undefined) {
        warn(`projectDocs: ${path} is not in the trusted revision`);
        return undefined;
      }
      if (Buffer.byteLength(text, "utf8") > PROJECT_DOC_FILE_LIMITS.bytes) {
        warn(
          `projectDocs: ${path} is skipped: it is larger than ${PROJECT_DOC_FILE_LIMITS.bytes} bytes`,
        );
        return undefined;
      }
      return { path, text };
    },
  );
  return docs.filter((d) => d !== undefined);
}
