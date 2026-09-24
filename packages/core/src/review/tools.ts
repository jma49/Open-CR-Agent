export const REVIEW_TOOLS = {
  readFile: "read_file",
  readDiff: "read_diff",
  codeSearch: "code_search",
  reportFinding: "report_finding",
  taskDone: "task_done",
} as const;

export type ReviewToolName = (typeof REVIEW_TOOLS)[keyof typeof REVIEW_TOOLS];
