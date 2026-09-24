import type { ChangeRequest, FileDiff, Hunk } from "../domain.js";
import type { ReviewerDefinition } from "./reviewer.js";
import { escapeAttribute, neutralizeTags } from "./sanitize.js";
import { REVIEW_TOOLS } from "./tools.js";

export const MAX_GUIDELINES_CHARS = 20_000;

export interface ReviewPromptInput {
  reviewer: ReviewerDefinition;
  changeRequest: ChangeRequest;
  changedFiles: readonly FileDiff[];
  bundle: readonly FileDiff[];
  rules: string;
  guidelines?: string | undefined;
}

export interface ReviewPrompt {
  system: string;
  user: string;
}

// Sections shared by every bundle of a run come first so providers can reuse
// the cached prefix; bundle-specific sections follow.
export function buildReviewPrompt(input: ReviewPromptInput): ReviewPrompt {
  const sections = [
    renderChangeRequest(input.changeRequest),
    renderChangedFiles(input.changedFiles),
  ];
  if (input.guidelines?.trim()) sections.push(renderGuidelines(input.guidelines));
  sections.push(
    `<review_rules>\n${input.rules}\n</review_rules>`,
    `<review_files>\n${input.bundle.map(renderFile).join("\n")}\n</review_files>`,
    `Review every file in <review_files>. Report each confirmed issue with ${REVIEW_TOOLS.reportFinding}, then call ${REVIEW_TOOLS.taskDone}.`,
  );
  return { system: input.reviewer.systemPrompt, user: sections.join("\n\n") };
}

function renderChangeRequest(cr: ChangeRequest): string {
  return [
    "<change_request>",
    `<title>${neutralizeTags(cr.title)}</title>`,
    `<description>\n${neutralizeTags(cr.description)}\n</description>`,
    "</change_request>",
  ].join("\n");
}

function renderChangedFiles(files: readonly FileDiff[]): string {
  const lines = files.map((f) => {
    const path = f.kind === "renamed" ? `${f.oldPath} -> ${f.newPath}` : f.newPath;
    return `${f.kind} ${neutralizeTags(path)} (+${f.additions} -${f.deletions})`;
  });
  return `<changed_files>\n${lines.join("\n")}\n</changed_files>`;
}

function renderGuidelines(guidelines: string): string {
  const truncated = guidelines.length > MAX_GUIDELINES_CHARS;
  const body = neutralizeTags(guidelines.slice(0, MAX_GUIDELINES_CHARS));
  return `<repository_guidelines>\n${body}${truncated ? "\n[truncated]" : ""}\n</repository_guidelines>`;
}

function renderFile(diff: FileDiff): string {
  const attributes = [`path="${escapeAttribute(diff.newPath)}"`, `change="${diff.kind}"`];
  if (diff.kind === "renamed") attributes.push(`from="${escapeAttribute(diff.oldPath)}"`);
  const body = diff.hunks.map(renderHunk).join("\n");
  return `<file ${attributes.join(" ")}>\n${neutralizeTags(body)}\n</file>`;
}

function renderHunk(hunk: Hunk): string {
  const lines = hunk.lines.map((l) => {
    const marker = l.kind === "add" ? "+" : l.kind === "delete" ? "-" : " ";
    return `${marker}${l.content}`;
  });
  return [hunk.header, ...lines].join("\n");
}
