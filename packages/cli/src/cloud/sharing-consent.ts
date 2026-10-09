import { readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { writePrivateFile } from "../io/private-file.js";

// This machine's consent to send findings and the code they quote. The
// switch lives in the account on ocra Cloud (ADR-0028, 2), so the server
// alone could turn it on; findings go only while this record agrees too.
// `ocra login` writes it, with the user at the terminal, when the account
// shares findings, and removes it otherwise; a review that finds the switch
// off removes it, so turning sharing on again takes a new login on each
// machine. It sits beside the credentials, readable only by this user.

const CONSENT = "on";

export function sharingConsentPath(credentialsPath: string): string {
  return join(dirname(credentialsPath), "share-findings");
}

/** Records or removes this machine's consent to send findings. */
export async function saveSharingConsent(credentialsPath: string, on: boolean): Promise<void> {
  const path = sharingConsentPath(credentialsPath);
  if (on) await writePrivateFile(path, `${CONSENT}\n`);
  else await rm(path, { force: true });
}

/** Whether this machine agreed to send findings; false when the record is absent or unreadable. */
export async function hasSharingConsent(credentialsPath: string): Promise<boolean> {
  try {
    return (await readFile(sharingConsentPath(credentialsPath), "utf8")).trim() === CONSENT;
  } catch {
    return false;
  }
}
