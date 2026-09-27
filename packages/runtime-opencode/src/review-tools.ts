import { promptData, REVIEW_TOOLS, severitySchema, type ToolDefinition } from "@open-cr-agent/core";
import { z } from "zod";

export const MAX_READ_LINES = 400;
export const MAX_SEARCH_RESULTS = 50;
// Lines and results are also capped in characters: one line of a minified
// bundle or a JSON fixture can be megabytes, and every step resends it.
export const MAX_LINE_CHARS = 2_000;
export const MAX_RESULT_CHARS = 50_000;

function clip(line: string, max = MAX_LINE_CHARS): string {
  return line.length > max ? `${line.slice(0, max)}…[${line.length - max} more characters]` : line;
}

// The whole lines that fit in the result cap.
function fitting(lines: readonly string[]): string[] {
  const kept: string[] = [];
  let size = 0;
  for (const line of lines) {
    size += line.length + 1;
    if (size > MAX_RESULT_CHARS) break;
    kept.push(line);
  }
  return kept;
}

export const reportFindingInput = z.object({
  file: z.string().min(1).describe("Path of a file in <ocra_review_files>"),
  existingCode: z
    .string()
    .min(1)
    .describe("1-5 lines copied verbatim from the new version of the file"),
  severity: severitySchema,
  title: z.string().min(1),
  body: z.string().min(1),
  suggestion: z.string().optional(),
  evidence: z.array(z.string()).optional(),
});

// Tool results carry repository text back to the model, so they are data
// like every prompt section: they cannot form one of ocra's tags.
const readFile: ToolDefinition = {
  name: REVIEW_TOOLS.readFile,
  description: `Read a file at the revision under review, with line numbers. Returns at most ${MAX_READ_LINES} lines; use startLine to page.`,
  inputSchema: z.object({
    path: z.string().min(1),
    startLine: z.number().int().positive().optional(),
  }),
  async execute(args, context) {
    const { path, startLine = 1 } = args as { path: string; startLine?: number };
    const content = await context.readFile(path);
    if (content === undefined) return promptData(`File not found: ${path}`);
    const lines = content.split("\n");
    const end = Math.min(lines.length, startLine + MAX_READ_LINES - 1);
    const body = fitting(
      lines.slice(startLine - 1, end).map((line, i) => `${startLine + i}: ${clip(line)}`),
    );
    const next = startLine + body.length;
    if (next <= lines.length) {
      body.push(
        `[truncated: ${lines.length - next + 1} more lines; call again with startLine=${next}]`,
      );
    }
    return promptData(body.join("\n"));
  },
};

const readDiff: ToolDefinition = {
  name: REVIEW_TOOLS.readDiff,
  description:
    "Read the diff of any changed file in this change, including files outside your bundle.",
  inputSchema: z.object({ path: z.string().min(1) }),
  async execute(args, context) {
    const { path } = args as { path: string };
    const diff = context.readDiff(path);
    if (diff === undefined) return promptData(`No changes to ${path} in this change.`);
    const lines = diff.split("\n").map((line) => clip(line));
    const kept = fitting(lines);
    if (kept.length < lines.length) kept.push(`[diff truncated after ${kept.length} lines]`);
    return promptData(kept.join("\n"));
  },
};

const codeSearch: ToolDefinition = {
  name: REVIEW_TOOLS.codeSearch,
  description: `Search the revision under review for a literal string (not a regex). Returns up to ${MAX_SEARCH_RESULTS} matches as path:line: text.`,
  inputSchema: z.object({ literal: z.string().min(2) }),
  async execute(args, context) {
    const { literal } = args as { literal: string };
    const matches = await context.searchCode(literal);
    if (matches.length === 0) return "No matches.";
    const shown = fitting(
      matches.slice(0, MAX_SEARCH_RESULTS).map((m) => `${m.path}:${m.line}: ${clip(m.text, 300)}`),
    );
    if (shown.length < matches.length) {
      shown.push(`[${matches.length - shown.length} more matches omitted]`);
    }
    return promptData(shown.join("\n"));
  },
};

const reportFinding: ToolDefinition = {
  name: REVIEW_TOOLS.reportFinding,
  description: "Report one confirmed defect. Call once per issue.",
  inputSchema: reportFindingInput,
  execute: async () => "Recorded.",
};

const taskDone: ToolDefinition = {
  name: REVIEW_TOOLS.taskDone,
  description: "Call once every file in <ocra_review_files> has been reviewed.",
  inputSchema: z.object({}),
  execute: async () => "Done.",
};

export const reviewTools: readonly ToolDefinition[] = [
  readFile,
  readDiff,
  codeSearch,
  reportFinding,
  taskDone,
];
