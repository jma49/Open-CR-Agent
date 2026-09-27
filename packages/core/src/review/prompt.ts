import type { ChangeRequest, FileDiff, Hunk } from "../domain.js";
import type { MemoryEntry } from "../memory/memory.js";
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
  accepted?: readonly MemoryEntry[];
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
  if (input.rules.trim()) {
    sections.push(`<ocra_review_rules>\n${neutralizeTags(input.rules)}\n</ocra_review_rules>`);
  }
  if (input.accepted && input.accepted.length > 0) sections.push(renderAccepted(input.accepted));
  sections.push(
    `<ocra_review_files>\n${input.bundle.map(renderFile).join("\n")}\n</ocra_review_files>`,
    `Review every file in <ocra_review_files>. Report each confirmed issue with ${REVIEW_TOOLS.reportFinding}, then call ${REVIEW_TOOLS.taskDone}. Where a file shows "‹ocra_", the file itself has "<ocra_"; quote it that way.`,
  );
  return { system: input.reviewer.systemPrompt, user: sections.join("\n\n") };
}

function renderChangeRequest(cr: ChangeRequest): string {
  return [
    "<ocra_change_request>",
    `<ocra_title>${neutralizeTags(cr.title)}</ocra_title>`,
    `<ocra_description>\n${neutralizeTags(cr.description)}\n</ocra_description>`,
    "</ocra_change_request>",
  ].join("\n");
}

function renderChangedFiles(files: readonly FileDiff[]): string {
  const lines = files.map((f) => {
    const path = f.kind === "renamed" ? `${f.oldPath} -> ${f.newPath}` : f.newPath;
    return `${f.kind} ${neutralizeTags(path)} (+${f.additions} -${f.deletions})`;
  });
  return `<ocra_changed_files>\n${lines.join("\n")}\n</ocra_changed_files>`;
}

function renderAccepted(entries: readonly MemoryEntry[]): string {
  const lines = entries.map((e) => `- ${e.file}: ${e.title} (accepted: ${e.reason})`);
  return `<ocra_accepted_findings>\nThe team has accepted these; do not report them again.\n${neutralizeTags(lines.join("\n"))}\n</ocra_accepted_findings>`;
}

function renderGuidelines(guidelines: string): string {
  const truncated = guidelines.length > MAX_GUIDELINES_CHARS;
  const body = neutralizeTags(guidelines.slice(0, MAX_GUIDELINES_CHARS));
  return `<ocra_repository_guidelines>\n${body}${truncated ? "\n[truncated]" : ""}\n</ocra_repository_guidelines>`;
}

function renderFile(diff: FileDiff): string {
  const attributes = [`path="${escapeAttribute(diff.newPath)}"`, `change="${diff.kind}"`];
  if (diff.kind === "renamed") attributes.push(`from="${escapeAttribute(diff.oldPath)}"`);
  const body = diff.hunks.map(renderHunk).join("\n");
  return `<ocra_file ${attributes.join(" ")}>\n${neutralizeTags(body)}\n</ocra_file>`;
}

function renderHunk(hunk: Hunk): string {
  const lines = hunk.lines.map((l) => {
    const marker = l.kind === "add" ? "+" : l.kind === "delete" ? "-" : " ";
    return `${marker}${l.content}`;
  });
  return [hunk.header, ...lines].join("\n");
}
