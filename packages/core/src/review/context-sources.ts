// What a review task's prompt is made of, one source per part (ADR-0057):
// the plan preview counts each one's tokens, and an ablation run leaves out
// the ones it names to measure what each is worth.
export const CONTEXT_SOURCES = [
  "system",
  "change_request",
  "changed_files",
  "linked_tasks",
  "guidelines",
  "rules",
  "accepted",
  "learnings",
  "project_docs",
  "diff",
  "reviewer",
  "callers",
  "analyzer",
  "plan",
  "instructions",
] as const;
export type ContextSource = (typeof CONTEXT_SOURCES)[number];

// The sources a run can leave out. ocra's and the reviewer's instructions,
// the diff and the plan phase are the review itself; "description" leaves
// out only the change request's description, and "rules" only the
// repository's rules.
export const OPTIONAL_CONTEXT = [
  "description",
  "changed_files",
  "linked_tasks",
  "guidelines",
  "rules",
  "accepted",
  "learnings",
  "project_docs",
  "callers",
  "analyzer",
] as const;
export type OptionalContext = (typeof OPTIONAL_CONTEXT)[number];

export function isOptionalContext(value: string): value is OptionalContext {
  return (OPTIONAL_CONTEXT as readonly string[]).includes(value);
}
