// What ocra Cloud keeps of an upload (ADR-0028). The CLI bounds what it
// sends to these, and the server bounds what it stores again, so a newer or
// a hostile client cannot make it keep more.

/** Shared findings kept per review. */
export const MAX_FINDINGS = 200;
/** Characters kept of each text field of a shared finding. */
export const MAX_FIELD = 4_096;
/** The text of one review's shared findings: title, body, suggestion and code. */
export const MAX_TOTAL_BYTES = 262_144;
/** Reviewers whose counts one upload carries. */
export const MAX_REVIEWERS = 40;
/** Findings an account remembers per repository (ADR-0028, 4). */
export const MAX_MEMORY_PER_REPO = 500;
/** Models in one failback chain. */
export const MAX_CHAIN = 4;
