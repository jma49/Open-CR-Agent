import { REVIEW_TOOLS, severitySchema, type ToolDefinition } from "@open-cr-agent/core";
import { z } from "zod";

export const MAX_READ_LINES = 400;
export const MAX_SEARCH_RESULTS = 50;

export const reportFindingInput = z.object({
  file: z.string().min(1).describe("Path of a file in <review_files>"),
  existingCode: z
    .string()
    .min(1)
    .describe("1-5 lines copied verbatim from the new version of the file"),
  severity: severitySchema,
  title: z.string().min(1),
  body: z.string().min(1),
  suggestion: z.string().optional(),
  evidence: z.array(z.string()).optional(),
  category: z.string().optional(),
});

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
    if (content === undefined) return `File not found: ${path}`;
    const lines = content.split("\n");
    const end = Math.min(lines.length, startLine + MAX_READ_LINES - 1);
    const body = lines.slice(startLine - 1, end).map((line, i) => `${startLine + i}: ${line}`);
    if (end < lines.length)
      body.push(
        `[truncated: ${lines.length - end} more lines; call again with startLine=${end + 1}]`,
      );
    return body.join("\n");
  },
};

const readDiff: ToolDefinition = {
  name: REVIEW_TOOLS.readDiff,
  description:
    "Read the diff of any changed file in this change, including files outside your bundle.",
  inputSchema: z.object({ path: z.string().min(1) }),
  async execute(args, context) {
    const { path } = args as { path: string };
    return context.readDiff(path) ?? `No changes to ${path} in this change.`;
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
    const shown = matches.slice(0, MAX_SEARCH_RESULTS).map((m) => `${m.path}:${m.line}: ${m.text}`);
    if (matches.length > MAX_SEARCH_RESULTS)
      shown.push(`[${matches.length - MAX_SEARCH_RESULTS} more matches omitted]`);
    return shown.join("\n");
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
  description: "Call once every file in <review_files> has been reviewed.",
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
