export const PROMPT_TAGS = [
  "change_request",
  "title",
  "description",
  "changed_files",
  "repository_guidelines",
  "review_rules",
  "review_files",
  "file",
  "finding",
  "findings",
  "diff",
  "file_excerpt",
  "accepted_findings",
] as const;

const TAG_PATTERN = new RegExp(`<(/?)(${PROMPT_TAGS.join("|")})(?=[\\s>/])`, "gi");

// Untrusted text must not be able to close or open one of our prompt sections
// and smuggle content outside it.
export function neutralizeTags(text: string): string {
  return text.replace(TAG_PATTERN, "‹$1$2");
}

export function escapeAttribute(value: string): string {
  return neutralizeTags(oneLine(value)).replaceAll('"', "&quot;");
}

// File names may contain newlines (git quotes and decodes them), which in a
// one-line field would start a line of their own in the prompt.
export function oneLine(text: string): string {
  return text.replace(/[\r\n\u2028\u2029]+/g, " ");
}
