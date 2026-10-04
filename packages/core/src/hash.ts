import { createHash } from "node:crypto";

// Sixteen hex characters of SHA-256: enough to tell ocra's ids, fingerprints
// and digests apart, short enough to read in a report.
export function shortHash(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}
