import { z } from "zod";
import type { Finding } from "../domain.js";
import { OcraError } from "../errors.js";

export const MEMORY_PATH = ".ocra/memory.json";
const MAX_ENTRIES = 1_000;

export const memoryEntrySchema = z.object({
  fingerprint: z.string().regex(/^[0-9a-f]{16}$/),
  file: z.string().min(1),
  title: z.string().min(1),
  reason: z.string().min(1),
  added: z.string().optional(),
});
export type MemoryEntry = z.infer<typeof memoryEntrySchema>;

const memoryFileSchema = z.object({ accepted: z.array(memoryEntrySchema).max(MAX_ENTRIES) });

// Findings the team has accepted, kept in the repository so they survive
// across changes and pull requests. It is read from the trusted revision:
// a pull request cannot silence its own findings by editing it.
export function parseMemory(json: string): MemoryEntry[] {
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch (error) {
    throw new OcraError(
      "CONFIG_INVALID",
      `${MEMORY_PATH} is not valid JSON: ${(error as Error).message}`,
      { cause: error },
    );
  }
  const parsed = memoryFileSchema.safeParse(data);
  if (!parsed.success)
    throw new OcraError(
      "CONFIG_INVALID",
      `${MEMORY_PATH} is invalid: ${z.prettifyError(parsed.error)}`,
    );
  return parsed.data.accepted;
}

export function serializeMemory(entries: readonly MemoryEntry[]): string {
  return `${JSON.stringify({ accepted: entries }, null, 2)}\n`;
}

// Where a remembered finding was accepted: the repository's file, or the
// memory of the ocra Cloud account that ran the review (ADR-0028).
export type MemorySource = "repository" | "account";
export type RememberedEntry = MemoryEntry & { source: MemorySource };

// The union of both sources; a fingerprint both list is the repository's.
export function mergeMemory(
  repository: readonly MemoryEntry[],
  account: readonly MemoryEntry[],
): RememberedEntry[] {
  const merged = repository.map((e): RememberedEntry => ({ ...e, source: "repository" }));
  const seen = new Set(repository.map((e) => e.fingerprint));
  for (const e of account) {
    if (seen.has(e.fingerprint)) continue;
    seen.add(e.fingerprint);
    merged.push({ ...e, source: "account" });
  }
  return merged;
}

export function applyMemory<E extends MemoryEntry>(
  findings: readonly Finding[],
  memory: readonly E[],
): { kept: Finding[]; remembered: E[] } {
  const accepted = new Map(memory.map((e) => [e.fingerprint, e]));
  const kept: Finding[] = [];
  const remembered: E[] = [];
  for (const finding of findings) {
    const entry = accepted.get(finding.fingerprint);
    if (entry) remembered.push(entry);
    else kept.push(finding);
  }
  return { kept, remembered };
}

// The entries about these files, for the reviewer's prompt.
export function memoryFor(files: readonly string[], memory: readonly MemoryEntry[]): MemoryEntry[] {
  const set = new Set(files);
  return memory.filter((e) => set.has(e.file));
}
