import type { ReviewContext } from "../contracts.js";
import type { Hunk } from "./patch.js";

// A line of a file as a lane left it: one of the head's, by its number
// there, or one the lane wrote.
interface Line {
  text: string;
  origin?: number;
}

interface EditedFile {
  head: string;
  lines: Line[];
}

export type EditRefusal = "missing" | "not_found" | "ambiguous" | "unchanged";

// Where a lane works (ADR-0078 point 13): the head through the review's
// access policy, with the lane's edits over it in memory. Nothing is written
// to disk, and the edits leave as hunks against the head.
export class Workspace {
  private readonly files = new Map<string, EditedFile>();
  private readonly head: ReviewContext;
  // What the lane's tools read: the files as edited; diffs and searches stay
  // the head's.
  readonly context: ReviewContext;

  constructor(head: ReviewContext) {
    this.head = head;
    this.context = {
      ...head,
      readFile: async (path) => {
        const edited = this.files.get(path);
        return edited ? text(edited.lines) : head.readFile(path);
      },
    };
  }

  // Replaces the whole lines `old` names, which must be in the file exactly
  // once: as written, else by their text without the indentation.
  async replace(
    path: string,
    old: string,
    replacement: string,
  ): Promise<{ startLine: number; lines: number } | EditRefusal> {
    const file = await this.open(path);
    if (!file) return "missing";
    const wanted = wholeLines(old);
    if (wanted.length === 0) return "not_found";
    const current = file.lines.map((l) => l.text);
    const exact = matches(current, wanted, (a, b) => a === b);
    const found = exact.length > 0 ? exact : matches(current, wanted, sameWithoutIndent);
    if (found.length === 0) return "not_found";
    if (found.length > 1) return "ambiguous";
    const at = found[0] as number;
    const written = wholeLines(replacement);
    if (text(file.lines.slice(at, at + wanted.length)) === written.join("\n")) return "unchanged";
    file.lines.splice(
      at,
      wanted.length,
      ...rewritten(file.lines.slice(at, at + wanted.length), written),
    );
    this.files.set(path, file);
    return { startLine: at + 1, lines: written.length };
  }

  // The edits as hunks against the head, and the head content of each file
  // they touch.
  patch(): { hunks: Hunk[]; heads: Map<string, string> } {
    const hunks: Hunk[] = [];
    const heads = new Map<string, string>();
    for (const [path, file] of [...this.files].sort(([a], [b]) => a.localeCompare(b))) {
      const changed = hunksOf(path, file);
      if (changed.length === 0) continue;
      hunks.push(...changed);
      heads.set(path, file.head);
    }
    return { hunks, heads };
  }

  private async open(path: string): Promise<EditedFile | undefined> {
    const edited = this.files.get(path);
    if (edited) return edited;
    let head: string | undefined;
    try {
      head = await this.head.readFile(path);
    } catch {
      // The access policy refuses the path: no lane reads or edits it.
      return undefined;
    }
    if (head === undefined) return undefined;
    return { head, lines: head.split("\n").map((line, i) => ({ text: line, origin: i + 1 })) };
  }
}

// The new lines, where those the edit repeats at either end stay the lines
// they were: a model restates the lines around the ones it changes.
function rewritten(old: readonly Line[], written: readonly string[]): Line[] {
  let before = 0;
  while (before < old.length && before < written.length && old[before]?.text === written[before]) {
    before += 1;
  }
  let after = 0;
  while (
    after < old.length - before &&
    after < written.length - before &&
    old[old.length - 1 - after]?.text === written[written.length - 1 - after]
  ) {
    after += 1;
  }
  return [
    ...old.slice(0, before),
    ...written.slice(before, written.length - after).map((line) => ({ text: line })),
    ...old.slice(old.length - after),
  ];
}

function text(lines: readonly Line[]): string {
  return lines.map((l) => l.text).join("\n");
}

// The argument's lines without the empty ones a model puts around them.
function wholeLines(value: string): string[] {
  const lines = value.replaceAll("\r\n", "\n").split("\n");
  while (lines.length > 0 && lines[0]?.trim() === "") lines.shift();
  while (lines.length > 0 && lines.at(-1)?.trim() === "") lines.pop();
  return lines;
}

function sameWithoutIndent(a: string, b: string): boolean {
  return a.trim() === b.trim();
}

function matches(
  lines: readonly string[],
  wanted: readonly string[],
  same: (a: string, b: string) => boolean,
): number[] {
  const found: number[] = [];
  for (let at = 0; at + wanted.length <= lines.length; at++) {
    if (wanted.every((line, i) => same(lines[at + i] as string, line))) found.push(at);
  }
  return found;
}

// One hunk per run of lines between two the lane left alone. A hunk replaces
// at least one line with at least one that is not empty text alone, which a
// hunk cannot say otherwise: an insertion, or a run that became one empty
// line, takes a neighbouring line with it.
function hunksOf(path: string, file: EditedFile): Hunk[] {
  const head = file.head.split("\n");
  const hunks: Hunk[] = [];
  let kept = 0;
  let written: string[] = [];
  const close = (next: number) => {
    let start = kept + 1;
    let end = next - 1;
    let lines = written;
    written = [];
    if (end < start && lines.length === 0) return;
    if (end < start || (lines.length === 1 && lines[0] === "")) {
      if (kept >= 1) {
        start = kept;
        lines = [head[kept - 1] as string, ...lines];
      } else if (next <= head.length) {
        end = next;
        lines = [...lines, head[next - 1] as string];
      }
    }
    const replacement = lines.join("\n");
    if (replacement === head.slice(start - 1, end).join("\n")) return;
    hunks.push({ path, startLine: start, endLine: end, replacement });
  };
  for (const line of file.lines) {
    if (line.origin === undefined) written.push(line.text);
    else {
      close(line.origin);
      kept = line.origin;
    }
  }
  close(head.length + 1);
  return merged(hunks);
}

// A neighbouring line taken twice joins its two hunks into one.
function merged(hunks: readonly Hunk[]): Hunk[] {
  const out: Hunk[] = [];
  for (const hunk of hunks) {
    const last = out.at(-1);
    if (last && hunk.startLine <= last.endLine) {
      out[out.length - 1] = {
        ...last,
        endLine: hunk.endLine,
        replacement: [last.replacement, ...hunk.replacement.split("\n").slice(1)].join("\n"),
      };
    } else out.push(hunk);
  }
  return out;
}
