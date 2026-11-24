// ocra's commands start a line with `@ocra`, as people mention it and as
// ocra Cloud reads its own commands. `/ocra`, the earlier form, still works.
const PREFIX = String.raw`[@/]ocra`;

export const OVERRIDE = new RegExp(
  String.raw`^${PREFIX} override ([0-9a-fA-F]{40}(?:[0-9a-fA-F]{24})?)\s+(\S.*)$`,
  "m",
);
export const REMEMBER = new RegExp(String.raw`^${PREFIX} remember\s+(\S[\s\S]*)$`, "m");
export const DISMISS = new RegExp(String.raw`^${PREFIX} dismiss\b`, "im");

// A comment that gives ocra a command: the review workflow, or the review
// itself, acts on it, so it is not a question to answer.
const COMMAND = new RegExp(String.raw`^\s*${PREFIX} (?:review|override|remember|dismiss)\b`, "im");

export function givesCommand(body: string): boolean {
  return COMMAND.test(body);
}
