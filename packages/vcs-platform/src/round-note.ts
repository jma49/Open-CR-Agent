import type { RoundNote, RoundNoteItem } from "@open-cr-agent/core";
import { codeSpan, safeLine } from "./render.js";

const MAX_LISTED = 20;
const MAX_TITLE_CHARS = 200;

// Why an item was left, by the loop's outcome for it; its reason follows as
// the loop's own word, which the manual explains.
const LEFT: Record<string, string> = {
  rejected: "no fix passed the checks this round; the next round tries again",
  deferred: "not written this round",
  needs_human: "left for a person",
  gone: "its code is no longer at the head",
};

// The comment a round of the fix loop leaves with its commit (ADR-0078
// point 7): what it fixed, what it left and why, and how to undo it. Titles,
// paths and check names come from the change and are neutralized.
export function renderRoundNote(note: RoundNote, changeRequest: string): string {
  const short = note.commitSha.slice(0, 12);
  const lines = [
    note.merge
      ? `ocra committed ${codeSpan(short)}, a merge of the base branch that resolves its conflicts in ${files(note.fixed.length)}:`
      : `ocra committed ${codeSpan(short)} with ${counted(note.fixed)}:`,
    "",
    ...listed(note.fixed, item),
  ];
  if (note.left.length > 0) {
    lines.push(
      "",
      "Not in this commit:",
      "",
      ...listed(note.left, (left) => {
        const why = LEFT[left.outcome] ?? left.outcome;
        return `${item(left)} (${why}${left.reason ? `: ${codeSpan(left.reason)}` : ""})`;
      }),
    );
  }
  lines.push(
    "",
    `ocra ran nothing from the repository to check these edits: this ${changeRequest}'s own checks test them. To undo the commit: ${codeSpan(`git revert ${note.merge ? "-m 1 " : ""}${short}`)}.`,
  );
  return lines.join("\n");
}

function counted(fixed: readonly RoundNoteItem[]): string {
  const checks = fixed.filter((f) => f.check).length;
  const findings = fixed.length - checks;
  const fixes = (n: number, of: string) => `${n} ${n === 1 ? "fix" : "fixes"} for ${of}`;
  return [
    ...(findings > 0 ? [fixes(findings, "accepted findings")] : []),
    ...(checks > 0 ? [fixes(checks, "failed checks")] : []),
  ].join(" and ");
}

function files(n: number): string {
  return `${n} ${n === 1 ? "file" : "files"}`;
}

function item(of: RoundNoteItem): string {
  const title = of.title.slice(0, MAX_TITLE_CHARS);
  if (of.check) return `check ${codeSpan(title)}`;
  return of.file ? `${codeSpan(of.file)}: ${safeLine(title)}` : safeLine(title);
}

function listed<T>(items: readonly T[], line: (item: T) => string): string[] {
  const shown = items.slice(0, MAX_LISTED).map((i) => `- ${line(i)}`);
  return items.length > MAX_LISTED ? [...shown, `- and ${items.length - MAX_LISTED} more`] : shown;
}
