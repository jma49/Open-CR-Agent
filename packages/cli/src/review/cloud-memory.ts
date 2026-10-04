import type { MemoryEntry } from "@open-cr-agent/core";
import { memoryEntrySchema } from "@open-cr-agent/core/internal";
import { type CloudDeps, cloudFetch, sessionLostReason } from "../cloud.js";

// The findings the account remembers for one repository (ADR-0028, 4), set
// from the web. A review applies them with .ocra/memory.json's.

// The server keeps at most 500 per repository; more is not an answer to trust.
const MAX_ENTRIES = 500;

/** The account's entries for the repository; [] and a warning when they cannot be read. */
export async function fetchAccountMemory(
  deps: CloudDeps,
  repoHash: string,
  warn: (message: string) => void,
): Promise<MemoryEntry[]> {
  let body: unknown;
  try {
    const answer = await cloudFetch(deps, `/api/memory?repo=${encodeURIComponent(repoHash)}`);
    if (answer.kind === "signed-out") return [];
    if (answer.kind !== "answered") throw new Error(sessionLostReason(answer));
    const { res } = answer;
    // A server without account memory has none to apply.
    if (res.status === 404) return [];
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    body = await res.json();
  } catch (error) {
    warn(
      `could not read your ocra Cloud memory (${error instanceof Error ? error.message : "error"}); the review applies the repository's alone`,
    );
    return [];
  }
  return parseAccountMemory(body, warn);
}

/** Whether the account remembers any finding, for any repository; false when that cannot be read. */
export async function accountHasMemory(deps: CloudDeps): Promise<boolean> {
  try {
    const answer = await cloudFetch(deps, "/api/memory");
    if (answer.kind !== "answered" || !answer.res.ok) return false;
    const entries = ((await answer.res.json()) as { entries?: unknown } | null)?.entries;
    return Array.isArray(entries) && entries.length > 0;
  } catch {
    return false;
  }
}

export function parseAccountMemory(body: unknown, warn: (message: string) => void): MemoryEntry[] {
  const list = (body as { entries?: unknown } | null)?.entries;
  if (!Array.isArray(list)) {
    warn("ignoring your ocra Cloud memory: the server's answer has no entries");
    return [];
  }
  const entries: MemoryEntry[] = [];
  let refused = 0;
  for (const raw of list.slice(0, MAX_ENTRIES)) {
    const r = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
    const parsed = memoryEntrySchema.safeParse({
      fingerprint: r.fingerprint,
      file: r.file,
      title: r.title,
      reason: r.reason,
      ...(typeof r.createdAt === "string" ? { added: r.createdAt.slice(0, 10) } : {}),
    });
    if (parsed.success) entries.push(parsed.data);
    else refused += 1;
  }
  if (refused > 0) {
    warn(
      `ignoring ${refused} ocra Cloud memory entr${refused > 1 ? "ies" : "y"} this version of ocra cannot read`,
    );
  }
  return entries;
}
