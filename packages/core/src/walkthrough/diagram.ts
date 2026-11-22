// A sequence diagram is model output that ends up rendered by the platform,
// so only the statements a sequence diagram needs pass: no directives,
// comments, links or click handlers, and no backtick or angle bracket that
// could close the fence or form markup. One line that fails drops the whole
// diagram, since half a flow misleads more than none.
const MAX_LINES = 40;
const MAX_LINE_CHARS = 160;

const ID = "[A-Za-z_][A-Za-z0-9_]*";
const ARROW = String.raw`(?:-->>|->>|-->|->|--x|-x|--\)|-\))[+-]?`;
const ARROW_ONCE = new RegExp(ARROW);
const STATEMENTS = [
  /^autonumber$/,
  new RegExp(`^(?:participant|actor) ${ID}(?: as [^:;]+)?$`),
  new RegExp(`^${ID} ?${ARROW} ?${ID}: .+$`),
  new RegExp(`^Note (?:left of|right of|over) ${ID}(?:, ?${ID})?: .+$`),
  /^(?:loop|alt|else|opt|par|and|critical|option|break)(?: .+)?$/,
  /^end$/,
  new RegExp(`^(?:activate|deactivate) ${ID}$`),
];

export function sequenceDiagram(text: string): string | undefined {
  const lines = text
    .trim()
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "");
  if (lines[0] !== "sequenceDiagram" || lines.length < 3 || lines.length > MAX_LINES + 1) {
    return undefined;
  }
  const body = lines.slice(1);
  const safe = body.every(
    (line) =>
      line.length <= MAX_LINE_CHARS &&
      !/[`<>%{}]/.test(line.replace(ARROW_ONCE, "")) &&
      STATEMENTS.some((statement) => statement.test(line)),
  );
  if (!safe || !balanced(body)) return undefined;
  return ["sequenceDiagram", ...body.map((line) => `  ${line}`)].join("\n");
}

const OPENS = /^(?:loop|alt|opt|par|critical|break)(?: |$)/;

function balanced(lines: readonly string[]): boolean {
  let depth = 0;
  for (const line of lines) {
    if (OPENS.test(line)) depth += 1;
    else if (line === "end") depth -= 1;
    if (depth < 0) return false;
  }
  return depth === 0;
}
