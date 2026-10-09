import { createHmac, timingSafeEqual } from "node:crypto";

// A session log lives in the reviewed tree, where a change can bring one of
// its own. Every line ocra writes ends with a seal: the HMAC of the run id and
// the line, keyed by a secret of this machine's user kept outside every
// repository. Only lines it sealed are read back as earlier results (--resume,
// ADR-0031). The seal is appended to the serialized line as its last field,
// so the bytes it covers need no canonical form and the line stays JSON.

export const SEAL_KEY = /^[0-9a-f]{64}$/;
const SEALED = /,"seal":"([0-9a-f]{64})"\}$/;

/** The serialized JSON object with its seal as a last field. */
export function sealLine(key: string, runId: string, line: string): string {
  // The seal goes in before the closing brace; any other line would come out
  // as something unsealLine, and every JSON reader, rejects.
  if (!line.startsWith("{") || !line.endsWith("}")) {
    throw new Error("sealLine: the line is not a serialized JSON object");
  }
  return `${line.slice(0, -1)},"seal":"${mac(key, runId, line).toString("hex")}"}`;
}

/** The line as it was before sealing; undefined unless key sealed it for this run. */
export function unsealLine(key: string, runId: string, sealed: string): string | undefined {
  const match = SEALED.exec(sealed);
  if (!match?.[1]) return undefined;
  const line = `${sealed.slice(0, match.index)}}`;
  return timingSafeEqual(Buffer.from(match[1], "hex"), mac(key, runId, line)) ? line : undefined;
}

function mac(key: string, runId: string, line: string): Buffer {
  return createHmac("sha256", Buffer.from(key, "hex")).update(`${runId}\n${line}`).digest();
}
