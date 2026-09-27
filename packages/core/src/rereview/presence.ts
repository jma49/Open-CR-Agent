import type { PriorReview } from "../domain.js";
import { mapWithConcurrency } from "../pipeline/pool.js";
import { containsQuote } from "./quote.js";

const READ_CONCURRENCY = 8;

// For each earlier finding not reported again: is its code still at head?
// A deleted file is a definite no; a failed read or a finding without a
// signature is left out, which reconcile treats as "cannot tell".
export async function priorCodePresence(
  prior: PriorReview | undefined,
  reported: ReadonlySet<string>,
  readFile: (path: string) => Promise<string | undefined>,
): Promise<Map<string, boolean>> {
  const presence = new Map<string, boolean>();
  if (!prior) return presence;
  const pending = prior.findings.filter((f) => !reported.has(f.fingerprint));
  await mapWithConcurrency(pending, READ_CONCURRENCY, async (old) => {
    let content: string | undefined;
    try {
      content = await readFile(old.file);
    } catch {
      return;
    }
    if (content === undefined) presence.set(old.fingerprint, false);
    else if (old.quote) presence.set(old.fingerprint, containsQuote(content, old.quote));
  });
  return presence;
}
