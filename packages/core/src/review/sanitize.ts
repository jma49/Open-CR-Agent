export const PROMPT_TAGS = [
  "change_request",
  "title",
  "description",
  "changed_files",
  "repository_guidelines",
  "review_rules",
  "review_files",
  "file",
] as const;

const TAG_PATTERN = new RegExp(`<(/?)(${PROMPT_TAGS.join("|")})(?=[\\s>/])`, "gi");

// Untrusted text must not be able to close or open one of our prompt sections
// and smuggle content outside it.
export function neutralizeTags(text: string): string {
  return text.replace(TAG_PATTERN, "‹$1$2");
}

export function escapeAttribute(value: string): string {
  return neutralizeTags(value).replaceAll('"', "&quot;");
}
