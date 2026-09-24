import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";

export const DATASET_URL =
  "https://huggingface.co/datasets/Alibaba-Aone/aacr-bench/resolve/main/dataset.json";

const recordSchema = z.object({
  project_main_language: z.string(),
  pr_url: z.string().url(),
  pr_source_commit: z.string().min(7),
  pr_target_commit: z.string().min(7),
  pr_change_line_count: z.coerce.number(),
  pr_category: z.string(),
  note: z.string(),
  path: z.string(),
  side: z.enum(["left", "right"]),
  from_line: z.coerce.number().nullable(),
  to_line: z.coerce.number().nullable(),
  category: z.string(),
  context: z.string(),
  label: z.coerce.number(),
});

export interface ReferenceComment {
  path: string;
  side: "left" | "right";
  fromLine: number | null;
  toLine: number | null;
  note: string;
  category: string;
  context: string;
}

export interface Instance {
  id: string;
  repo: string;
  prUrl: string;
  language: string;
  prCategory: string;
  baseCommit: string;
  headCommit: string;
  changeLines: number;
  references: ReferenceComment[];
}

export async function loadDataset(
  cachePath: string,
  fetchImpl: typeof fetch = fetch,
): Promise<Instance[]> {
  let text: string;
  try {
    text = await readFile(cachePath, "utf8");
  } catch {
    const response = await fetchImpl(DATASET_URL);
    if (!response.ok) throw new Error(`Downloading AACR-Bench failed: HTTP ${response.status}`);
    text = await response.text();
    await mkdir(dirname(cachePath), { recursive: true });
    await writeFile(cachePath, text);
  }
  return toInstances(parseRecords(JSON.parse(text)));
}

export type DatasetRecord = z.infer<typeof recordSchema>;

export function parseRecords(data: unknown): DatasetRecord[] {
  return z.array(recordSchema).parse(data);
}

// Only comments labeled correct are ground truth; the incorrect ones exist to
// evaluate comment filters, not reviewers.
export function toInstances(records: readonly DatasetRecord[]): Instance[] {
  const byPr = new Map<string, Instance>();
  for (const r of records) {
    const repo = new URL(r.pr_url).pathname.split("/").slice(1, 3).join("/");
    let instance = byPr.get(r.pr_url);
    if (!instance) {
      instance = {
        id: `${repo.replace("/", "__")}@${r.pr_target_commit.slice(0, 7)}`,
        repo,
        prUrl: r.pr_url,
        language: r.project_main_language,
        prCategory: r.pr_category,
        baseCommit: r.pr_source_commit,
        headCommit: r.pr_target_commit,
        changeLines: r.pr_change_line_count,
        references: [],
      };
      byPr.set(r.pr_url, instance);
    }
    if (r.label === 1) {
      instance.references.push({
        path: r.path,
        side: r.side,
        fromLine: r.from_line,
        toLine: r.to_line,
        note: r.note,
        category: r.category,
        context: r.context,
      });
    }
  }
  return [...byPr.values()].sort((a, b) => a.id.localeCompare(b.id));
}
