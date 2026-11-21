import type { CodeMatch } from "@open-cr-agent/core";
import { git } from "./git.js";

const RESULT_LIMIT = 100;
const MATCHES_PER_FILE = 20;
const OUTPUT_BYTES = 4 * 1024 * 1024;
const BATCH_SIZE = 32;

export interface SearchScope {
  root: string;
  // Absent: the workspace, untracked files included.
  head: string | undefined;
  attributes: readonly string[];
}

/**
 * `git grep` at a revision reads every blob of the tree, so each search
 * costs the same however small; searches asked for in the same turn (an
 * agent's tool calls, the callers of a bundle's symbols) share one grep.
 */
export class CodeSearch {
  private queue: { literal: string; done: (r: Promise<CodeMatch[]>) => void }[] = [];
  private readonly scope: () => Promise<SearchScope>;

  constructor(scope: () => Promise<SearchScope>) {
    this.scope = scope;
  }

  search(literal: string): Promise<CodeMatch[]> {
    if (!batchable(literal)) return this.scope().then((s) => grepOne(s, literal));
    return new Promise((resolve) => {
      if (this.queue.length === 0) queueMicrotask(() => this.flush());
      this.queue.push({ literal, done: resolve });
    });
  }

  private flush(): void {
    const queued = this.queue;
    this.queue = [];
    for (let i = 0; i < queued.length; i += BATCH_SIZE) {
      const batch = queued.slice(i, i + BATCH_SIZE);
      const results = this.scope().then((s) =>
        grepMany(s, [...new Set(batch.map((q) => q.literal))]),
      );
      for (const q of batch) q.done(results.then((r) => r.get(q.literal) ?? []));
    }
  }
}

// A literal with a line break is several patterns to git.
function batchable(literal: string): boolean {
  return literal !== "" && !/[\r\n]/.test(literal);
}

async function grepMany(scope: SearchScope, literals: string[]): Promise<Map<string, CodeMatch[]>> {
  if (literals.length === 1) {
    const [literal = ""] = literals;
    return new Map([[literal, await grepOne(scope, literal)]]);
  }
  // One alternation, not one -e per literal: git scans the rest of the file
  // for each -F pattern at every matching line, quadratic in a large file.
  const out = await grep(scope, ["-E", "-e", literals.map(ereLiteral).join("|")], OUTPUT_BYTES);
  // Cut at the cap, one literal's lines may have crowded out another's.
  if (Buffer.byteLength(out) >= OUTPUT_BYTES || (out !== "" && !out.endsWith("\n"))) {
    const each = await Promise.all(literals.map((l) => grepOne(scope, l)));
    return new Map(literals.map((l, i) => [l, each[i] ?? []]));
  }
  const lines = parse(scope, out);
  return new Map(literals.map((l) => [l, limited(lines.filter((m) => m.text.includes(l)))]));
}

function ereLiteral(literal: string): string {
  return literal.replace(/[\\.[\](){}*+?^$|]/g, "\\$&");
}

async function grepOne(scope: SearchScope, literal: string): Promise<CodeMatch[]> {
  const out = await grep(
    scope,
    ["-F", "-m", String(MATCHES_PER_FILE), "-e", literal],
    OUTPUT_BYTES,
  );
  const lines = out.split("\n");
  // Output cut at the byte cap ends inside a line.
  if (!out.endsWith("\n")) lines.pop();
  return parse(scope, lines.join("\n")).slice(0, RESULT_LIMIT);
}

// What `-m` does for one literal: at most so many lines per file.
function limited(matches: CodeMatch[]): CodeMatch[] {
  const perFile = new Map<string, number>();
  const kept: CodeMatch[] = [];
  for (const m of matches) {
    const n = perFile.get(m.path) ?? 0;
    if (n >= MATCHES_PER_FILE) continue;
    perFile.set(m.path, n + 1);
    kept.push(m);
    if (kept.length === RESULT_LIMIT) break;
  }
  return kept;
}

function grep(scope: SearchScope, patterns: string[], cap: number): Promise<string> {
  const args = [...scope.attributes, "grep", "-n", "-z", "-I", "--no-color", "--full-name"];
  if (scope.head === undefined) args.push("--untracked");
  args.push(...patterns);
  if (scope.head !== undefined) args.push(scope.head);
  return git([...args, "--"], { cwd: scope.root, okExitCodes: [0, 1], truncateAt: cap });
}

function parse(scope: SearchScope, out: string): CodeMatch[] {
  const prefix = scope.head === undefined ? "" : `${scope.head}:`;
  return out
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => {
      const [path = "", lineNumber = "0", ...text] = line.split("\0");
      return { path: path.slice(prefix.length), line: Number(lineNumber), text: text.join("\0") };
    });
}
