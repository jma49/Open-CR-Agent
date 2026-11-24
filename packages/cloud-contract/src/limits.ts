// What ocra Cloud keeps of an upload (ADR-0028). The CLI bounds what it
// sends to these, and the server bounds what it stores again, so a newer or
// a hostile client cannot make it keep more.

/** Shared findings kept per review. */
export const MAX_FINDINGS = 200;
/** Characters kept of each text field of a shared finding. */
export const MAX_FIELD = 4_096;
/** Evidence entries kept per shared finding, as many as a platform comment shows. */
export const MAX_EVIDENCE = 5;
/** Characters kept of one evidence entry. */
export const MAX_EVIDENCE_FIELD = 300;
/** The text of one review's shared findings: title, body, suggestion, code, fix and evidence. */
export const MAX_TOTAL_BYTES = 262_144;
/** Characters of a rule's text: an account's rule, and a rule's text in an upload. */
export const MAX_RULE_TEXT = 2_000;
/** Reviewers whose counts one upload carries. */
export const MAX_REVIEWERS = 40;
/** Findings an account remembers per repository (ADR-0028, 4). */
export const MAX_MEMORY_PER_REPO = 500;
/** Models in one failback chain. */
export const MAX_CHAIN = 4;
