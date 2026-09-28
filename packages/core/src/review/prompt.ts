import type { ChangeRequest, FileDiff, Hunk } from "../domain.js";
import type { MemoryEntry } from "../memory/memory.js";
import type { ReviewerDefinition } from "./reviewer.js";
import { escapeAttribute, neutralizeTags, oneLine } from "./sanitize.js";
import { REVIEW_TOOLS } from "./tools.js";

export const MAX_GUIDELINES_CHARS = 20_000;

// Runtimes cap an agent's turns, and on OpenCode the last turn has no tools:
// a reviewer that kept its findings for the end lost them. A quarter of the
// review tasks on Vertex ended at the cap (2026-09-28).
export const TURN_BUDGET = `## Turn budget
Your turns are limited, and the last one allows no tool calls, so a finding you have not reported by then is lost. Report each issue with ${REVIEW_TOOLS.reportFinding} as soon as you have confirmed it, before you investigate the next one; never keep findings for the end. Spread your turns over every file in <review_files>.`;

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
    sections.push(`<review_rules>\n${neutralizeTags(input.rules)}\n</review_rules>`);
  }
  if (input.accepted && input.accepted.length > 0) sections.push(renderAccepted(input.accepted));
  sections.push(
    `<review_files>\n${input.bundle.map(renderFile).join("\n")}\n</review_files>`,
    `Review every file in <review_files>. Report each issue with ${REVIEW_TOOLS.reportFinding} as soon as you confirm it, then call ${REVIEW_TOOLS.taskDone}.`,
  );
  return {
    system: `${input.reviewer.systemPrompt}\n\n${TURN_BUDGET}`,
    user: sections.join("\n\n"),
  };
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
    return `${f.kind} ${neutralizeTags(oneLine(path))} (+${f.additions} -${f.deletions})`;
  });
  return `<changed_files>\n${lines.join("\n")}\n</changed_files>`;
}

function renderAccepted(entries: readonly MemoryEntry[]): string {
  const lines = entries.map((e) => `- ${e.file}: ${e.title} (accepted: ${e.reason})`);
  return `<accepted_findings>\nThe team has accepted these; do not report them again.\n${neutralizeTags(lines.join("\n"))}\n</accepted_findings>`;
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
