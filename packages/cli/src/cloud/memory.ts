import type { MemoryEntry } from "@open-cr-agent/core";
import { errorMessage, memoryEntrySchema } from "@open-cr-agent/core/internal";
import { CloudClient, type CloudResult, sessionLostReason } from "./client.js";
import type { CloudDeps } from "./deps.js";

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
  const cannotRead = (reason: string) => {
    warn(
      `could not read your ocra Cloud memory (${reason}); the review applies the repository's alone`,
    );
    return [];
  };
  let answer: CloudResult<unknown[]>;
  try {
    answer = await new CloudClient(deps).memory(repoHash);
  } catch (error) {
    return cannotRead(errorMessage(error));
  }
  switch (answer.kind) {
    case "ok":
      return parseAccountMemory(answer.value, warn);
    case "signed-out":
      return [];
    case "status":
      // A server without account memory has none to apply.
      return answer.status === 404 ? [] : cannotRead(`HTTP ${answer.status}`);
    case "malformed":
      warn("ignoring your ocra Cloud memory: the server's answer has no entries");
      return [];
    default:
      return cannotRead(sessionLostReason(answer));
  }
}

/** Whether the account remembers any finding, for any repository; false when that cannot be read. */
export async function accountHasMemory(deps: CloudDeps): Promise<boolean> {
  try {
    const answer = await new CloudClient(deps).memory();
    return answer.kind === "ok" && answer.value.length > 0;
  } catch {
    return false;
  }
}

export function parseAccountMemory(
  list: readonly unknown[],
  warn: (message: string) => void,
): MemoryEntry[] {
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
