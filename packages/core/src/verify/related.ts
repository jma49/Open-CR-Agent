import type { ReviewContext } from "../contracts.js";
import type { Finding } from "../domain.js";

// Where the names in each finding's quoted code are defined and used
// elsewhere, so the verifier can settle a claim that depends on a caller, a
// type or a guard outside the excerpt instead of answering "uncertain". Found
// by literal search, bounded; a miss only costs the hint.
const MAX_NAMES_PER_FINDING = 3;
const MAX_USES_PER_NAME = 4;
const MAX_LINES = 60;
const MAX_LINE_CHARS = 200;
// The excerpt already shows this much around a finding (prompt.ts).
const EXCERPT_CONTEXT_LINES = 40;

const COMMON = new Set([
  "async",
  "await",
  "break",
  "case",
  "catch",
  "class",
  "const",
  "continue",
  "default",
  "delete",
  "else",
  "export",
  "false",
  "finally",
  "from",
  "function",
  "import",
  "interface",
  "let",
  "null",
  "number",
  "object",
  "private",
  "public",
  "return",
  "self",
  "static",
  "string",
  "super",
  "switch",
  "this",
  "throw",
  "true",
  "type",
  "typeof",
  "undefined",
  "void",
  "while",
  "with",
  "yield",
]);

function quotedNames(code: string): string[] {
  const names: string[] = [];
  for (const [name] of code.matchAll(/[A-Za-z_$][\w$]*/g)) {
    if (name.length < 4 || COMMON.has(name.toLowerCase()) || names.includes(name)) continue;
    names.push(name);
    if (names.length === MAX_NAMES_PER_FINDING) break;
  }
  return names;
}

export async function relatedCode(
  file: string,
  findings: readonly Finding[],
  context: Pick<ReviewContext, "searchCode">,
): Promise<string | undefined> {
  const shown = (path: string, line: number) =>
    path === file &&
    findings.some(
      (f) =>
        f.lineRange !== undefined &&
        line >= f.lineRange.start - EXCERPT_CONTEXT_LINES &&
        line <= f.lineRange.end + EXCERPT_CONTEXT_LINES,
    );
  const names = [...new Set(findings.flatMap((f) => quotedNames(f.existingCode)))];
  const out: string[] = [];
  for (const name of names) {
    const word = new RegExp(`(^|[^\\w$])${name.replace(/\$/g, "\\$")}($|[^\\w$])`);
    const matches = await context.searchCode(name).catch(() => []);
    const uses = matches
      .filter((m) => word.test(m.text) && !shown(m.path, m.line))
      .slice(0, MAX_USES_PER_NAME);
    if (uses.length === 0) continue;
    if (out.length + uses.length + 1 > MAX_LINES) break;
    out.push(`${name}:`);
    for (const m of uses)
      out.push(`${m.path}:${m.line}: ${m.text.trim().slice(0, MAX_LINE_CHARS)}`);
  }
  return out.length > 0 ? out.join("\n") : undefined;
}
