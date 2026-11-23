import type { CodeMatch } from "@open-cr-agent/core";
import { gitLines } from "./git.js";

const RESULT_LIMIT = 100;
const MATCHES_PER_FILE = 20;
// What one search may read of git's output: a line of a minified bundle or
// a fixture can be megabytes.
const OUTPUT_CHARS = 4 * 1024 * 1024;
// A line that long in bytes is longer in characters than a search may read.
const MAX_LINE_BYTES = 3 * OUTPUT_CHARS;
const BATCH_SIZE = 32;

export interface SearchScope {
  root: string;
  // Absent: the workspace, untracked files included.
  head: string | undefined;
  attributes: readonly string[];
}

/**
 * `git grep` at a revision reads every blob of the tree on every core, so
 * each search costs the same however small and two at once only take turns.
 * One grep runs at a time: searches asked for in the same turn (an agent's
 * tool calls, the callers of a bundle's symbols) or while another runs
 * share the next, and it is stopped once each has all it returns.
 */
export class CodeSearch {
  private queue: { literal: string; done: (r: Promise<CodeMatch[]>) => void }[] = [];
  private draining = false;
  private readonly scope: () => Promise<SearchScope>;

  constructor(scope: () => Promise<SearchScope>) {
    this.scope = scope;
  }

  search(literal: string): Promise<CodeMatch[]> {
    if (!batchable(literal)) return this.scope().then((s) => grepOne(s, literal));
    return new Promise((resolve) => {
      if (this.queue.length === 0 && !this.draining) queueMicrotask(() => void this.drain());
      this.queue.push({ literal, done: resolve });
    });
  }

  private async drain(): Promise<void> {
    this.draining = true;
    while (this.queue.length > 0) {
      const batch = this.queue.splice(0, BATCH_SIZE);
      const results = this.scope().then((s) =>
        grepMany(s, [...new Set(batch.map((q) => q.literal))]),
      );
      for (const q of batch) q.done(results.then((r) => r.get(q.literal) ?? []));
      await results.catch(() => undefined);
    }
    this.draining = false;
  }
}

// A literal with a line break is several patterns to git.
function batchable(literal: string): boolean {
  return literal !== "" && !/[\r\n]/.test(literal);
}

// What a search of one literal returns of the lines git lists for it: at
// most MATCHES_PER_FILE a file and RESULT_LIMIT in all, within OUTPUT_CHARS
// of output.
class Matches {
  readonly kept: CodeMatch[] = [];
  full = false;
  private chars = 0;
  private path: string | undefined;
  private inFile = 0;

  // git lists a file's lines together.
  add(match: CodeMatch, lineChars: number): void {
    if (this.full) return;
    if (match.path !== this.path) {
      this.path = match.path;
      this.inFile = 0;
    }
    if (this.inFile === MATCHES_PER_FILE) return;
    this.inFile += 1;
    this.chars += lineChars + 1;
    if (this.chars > OUTPUT_CHARS) {
      this.full = true;
      return;
    }
    this.kept.push(match);
    if (this.kept.length === RESULT_LIMIT) this.full = true;
  }
}

async function grepMany(scope: SearchScope, literals: string[]): Promise<Map<string, CodeMatch[]>> {
  if (literals.length === 1) {
    const [literal = ""] = literals;
    return new Map([[literal, await grepOne(scope, literal)]]);
  }
  const found = new Map(literals.map((literal) => [literal, new Matches()]));
  // One alternation, not one -e per literal: git scans the rest of the file
  // for each -F pattern at every matching line, quadratic in a large file.
  const outcome = await grep(
    scope,
    ["-E", "-e", literals.map(ereLiteral).join("|")],
    (match, lineChars) => {
      let open = false;
      for (const [literal, matches] of found) {
        if (match.text.includes(literal)) matches.add(match, lineChars);
        open ||= !matches.full;
      }
      return open;
    },
  );
  // Which literals a line that was not read holds is unknown.
  if (outcome === "line_too_long") {
    const each = new Map<string, CodeMatch[]>();
    for (const literal of literals) each.set(literal, await grepOne(scope, literal));
    return each;
  }
  return new Map([...found].map(([literal, matches]) => [literal, matches.kept]));
}

function ereLiteral(literal: string): string {
  return literal.replace(/[\\.[\](){}*+?^$|]/g, "\\$&");
}

async function grepOne(scope: SearchScope, literal: string): Promise<CodeMatch[]> {
  const matches = new Matches();
  await grep(scope, ["-F", "-m", String(MATCHES_PER_FILE), "-e", literal], (match, lineChars) => {
    matches.add(match, lineChars);
    return !matches.full;
  });
  return matches.kept;
}

// Each matching line to `onMatch`, until it returns false.
function grep(
  scope: SearchScope,
  patterns: string[],
  onMatch: (match: CodeMatch, lineChars: number) => boolean,
): Promise<"ended" | "stopped" | "line_too_long"> {
  const args = [...scope.attributes, "grep", "-n", "-z", "-I", "--no-color", "--full-name"];
  if (scope.head === undefined) args.push("--untracked");
  args.push(...patterns);
  if (scope.head !== undefined) args.push(scope.head);
  const prefix = scope.head === undefined ? "" : `${scope.head}:`;
  return gitLines(
    [...args, "--"],
    { cwd: scope.root, okExitCodes: [0, 1], maxLineBytes: MAX_LINE_BYTES },
    (line) => {
      if (line === "") return true;
      const [path = "", lineNumber = "0", ...text] = line.split("\0");
      const match = {
        path: path.slice(prefix.length),
        line: Number(lineNumber),
        text: text.join("\0"),
      };
      return onMatch(match, line.length);
    },
  );
}
