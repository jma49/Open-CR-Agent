import type { MemoryEntry } from "@open-cr-agent/core";
import { memoryEntrySchema } from "@open-cr-agent/core/internal";
import type { CloudDeps, Credentials } from "../cloud.js";
import { VERSION } from "../version.js";

// The findings the account remembers for one repository (ADR-0028, 4), set
// from the web. A review applies them with .ocra/memory.json's.

// The server keeps at most 500 per repository; more is not an answer to trust.
const MAX_ENTRIES = 500;

/** The account's entries for the repository; [] and a warning when they cannot be read. */
export async function fetchAccountMemory(
  deps: Pick<CloudDeps, "fetch">,
  session: Pick<Credentials, "server" | "access_token">,
  repoHash: string,
  warn: (message: string) => void,
): Promise<MemoryEntry[]> {
  let body: unknown;
  try {
    const res = await deps.fetch(
      `${session.server}/api/memory?repo=${encodeURIComponent(repoHash)}`,
      {
        headers: {
          authorization: `Bearer ${session.access_token}`,
          "user-agent": `ocra/${VERSION}`,
        },
        signal: AbortSignal.timeout(15_000),
      },
    );
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
