import type { ChangeRequest, FileDiff, Hunk } from "../domain.js";
import type { MemoryEntry } from "../memory/memory.js";
import {
  data,
  join,
  ocraText,
  oneLine,
  type PromptText,
  section,
  truncated,
} from "./prompt-text.js";
import type { ReviewerDefinition } from "./reviewer.js";
import { REVIEW_TOOLS } from "./tools.js";

export const MAX_GUIDELINES_CHARS = 20_000;

// Runtimes cap an agent's turns, and on OpenCode the last turn has no tools:
// a reviewer that kept its findings for the end lost them. A quarter of the
// review tasks on Vertex ended at the cap (2026-09-28).
export const TURN_BUDGET = `## Turn budget
Your turns are limited, and the last one allows no tool calls, so a finding you have not reported by then is lost. Report each issue with ${REVIEW_TOOLS.reportFinding} as soon as you have confirmed it, before you investigate the next one; never keep findings for the end. Spread your turns over every file in <ocra_review_files>.`;

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
  if (input.guidelines?.trim()) {
    sections.push(
      section("repository_guidelines", truncated(input.guidelines, MAX_GUIDELINES_CHARS)),
    );
  }
  if (input.rules.trim()) sections.push(section("review_rules", data(input.rules)));
  if (input.accepted && input.accepted.length > 0) sections.push(renderAccepted(input.accepted));
  sections.push(
    section("review_files", input.bundle.map(renderFile)),
    ocraText(
      `Review every file in <ocra_review_files>. Report each issue with ${REVIEW_TOOLS.reportFinding} as soon as you confirm it, then call ${REVIEW_TOOLS.taskDone}. Where a file shows "‹ocra_", the file itself has "<ocra_"; quote it that way.`,
    ),
  );
  return {
    system: `${input.reviewer.systemPrompt}\n\n${TURN_BUDGET}`,
    user: join(sections, "\n\n"),
  };
}

export const MAX_TITLE_CHARS = 300;
export const MAX_DESCRIPTION_CHARS = 8_000;

// Also used by the judge, which sees the same change request.
export function renderChangeRequest(cr: ChangeRequest, maxDescription = MAX_DESCRIPTION_CHARS) {
  return section("change_request", [
    section("title", truncated(cr.title, MAX_TITLE_CHARS)),
    section("description", truncated(cr.description, maxDescription)),
  ]);
}

function renderChangedFiles(files: readonly FileDiff[]): PromptText {
  const lines = files.map((f) => {
    const path = f.kind === "renamed" ? `${f.oldPath} -> ${f.newPath}` : f.newPath;
    return join(
      [ocraText(`${f.kind} `), data(oneLine(path)), ocraText(` (+${f.additions} -${f.deletions})`)],
      "",
    );
  });
  return section("changed_files", lines);
}

function renderAccepted(entries: readonly MemoryEntry[]): PromptText {
  const lines = entries.map((e) => data(`- ${e.file}: ${e.title} (accepted: ${e.reason})`));
  return section("accepted_findings", [
    ocraText("The team has accepted these; do not report them again."),
    ...lines,
  ]);
}

function renderFile(diff: FileDiff): PromptText {
  const attributes: Record<string, string> = { path: diff.newPath, change: diff.kind };
  if (diff.kind === "renamed") attributes.from = diff.oldPath;
  return section("file", data(diff.hunks.map(renderHunk).join("\n")), attributes);
}

function renderHunk(hunk: Hunk): string {
  const lines = hunk.lines.map((l) => {
    const marker = l.kind === "add" ? "+" : l.kind === "delete" ? "-" : " ";
    return `${marker}${l.content}`;
  });
  return [hunk.header, ...lines].join("\n");
}
