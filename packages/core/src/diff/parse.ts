import type { FileChangeKind, FileDiff } from "../domain.js";
import { parseHunks } from "./hunks.js";
import { readQuotedToken } from "./quoted-path.js";

const FILE_HEADER = "diff --git ";

export function parseUnifiedDiff(text: string): FileDiff[] {
  const lines = splitLines(text);
  const sections: string[][] = [];
  for (const line of lines) {
    if (line.startsWith(FILE_HEADER)) sections.push([line]);
    else sections.at(-1)?.push(line);
  }
  return sections.map(parseFileSection);
}

// Trailing CRs are dropped so a diff saved with CRLF endings parses like any
// other; reviewers compare normalized text, so CRLF content loses nothing.
function splitLines(text: string): string[] {
  const lines = text.split("\n").map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

function parseFileSection(lines: string[]): FileDiff {
  const header = parseHeaderPaths((lines[0] as string).slice(FILE_HEADER.length));
  let oldPath = header?.oldPath ?? "";
  let newPath = header?.newPath ?? "";
  let kind: FileChangeKind = "modified";
  let isBinary = false;

  let i = 1;
  for (; i < lines.length && !(lines[i] as string).startsWith("@@"); i += 1) {
    const line = lines[i] as string;
    if (line.startsWith("new file mode")) kind = "added";
    else if (line.startsWith("deleted file mode")) kind = "deleted";
    else if (line.startsWith("rename from ")) {
      oldPath = unquote(line.slice("rename from ".length));
      kind = "renamed";
    } else if (line.startsWith("rename to ")) newPath = unquote(line.slice("rename to ".length));
    else if (line.startsWith("copy from ")) {
      oldPath = unquote(line.slice("copy from ".length));
      kind = "added";
    } else if (line.startsWith("copy to ")) newPath = unquote(line.slice("copy to ".length));
    else if (line.startsWith("Binary files ") || line === "GIT binary patch") isBinary = true;
    else if (line.startsWith("--- ")) oldPath = parseMarkerPath(line.slice(4)) ?? oldPath;
    else if (line.startsWith("+++ ")) newPath = parseMarkerPath(line.slice(4)) ?? newPath;
  }

  const hunks = parseHunks(lines.slice(i));
  let additions = 0;
  let deletions = 0;
  for (const line of hunks.flatMap((h) => h.lines)) {
    if (line.kind === "add") additions += 1;
    else if (line.kind === "delete") deletions += 1;
  }

  return {
    oldPath,
    newPath,
    kind,
    isBinary,
    additions,
    deletions,
    hunks,
    patch: lines.join("\n"),
  };
}

function parseHeaderPaths(rest: string): { oldPath: string; newPath: string } | undefined {
  const quotedOld = readQuotedToken(rest, 0);
  if (quotedOld) {
    const newRaw = rest.slice(quotedOld.end + 1);
    return { oldPath: stripPrefix(quotedOld.value), newPath: stripPrefix(unquote(newRaw)) };
  }

  const quotedNewAt = rest.indexOf(' "');
  if (quotedNewAt >= 0) {
    return {
      oldPath: stripPrefix(rest.slice(0, quotedNewAt)),
      newPath: stripPrefix(unquote(rest.slice(quotedNewAt + 1))),
    };
  }

  // Unquoted paths may contain spaces, so "a/x b/x" is split at its midpoint
  // when both halves name the same file, which is the only unambiguous case.
  const mid = (rest.length - 1) / 2;
  if (Number.isInteger(mid) && rest[mid] === " ") {
    const oldPath = stripPrefix(rest.slice(0, mid));
    const newPath = stripPrefix(rest.slice(mid + 1));
    if (oldPath === newPath) return { oldPath, newPath };
  }

  const split = rest.indexOf(" b/");
  if (split < 0) return undefined;
  return {
    oldPath: stripPrefix(rest.slice(0, split)),
    newPath: stripPrefix(rest.slice(split + 1)),
  };
}

function parseMarkerPath(rest: string): string | undefined {
  const quoted = readQuotedToken(rest, 0);
  const path = quoted ? quoted.value : (rest.split("\t")[0] as string);
  return path === "/dev/null" ? undefined : stripPrefix(path);
}

function unquote(raw: string): string {
  return readQuotedToken(raw, 0)?.value ?? raw;
}

function stripPrefix(path: string): string {
  return path.startsWith("a/") || path.startsWith("b/") ? path.slice(2) : path;
}
