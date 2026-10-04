// For the scripts that stand in for `ocra review` in the tests: JavaScript
// defining report(fields) and task(taskId, status, error?), which fill in
// the rest of a version 1 report, so what the scripts write is a report
// ocra could have written (eval reads it through the report schema).
export const FAKE_REPORT_JS = `
const zero = { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cachedTokens: 0, costUsd: 0 };
const task = (taskId, status, error) => ({ taskId, reviewer: taskId.split("-")[0], bundle: "b",
  files: [], status, findings: 0, durationMs: 0, usage: zero, ...(error ? { error } : {}) });
const report = (fields) => ({ version: 1,
  changeRequest: { id: "1", title: "t", description: "", baseSha: "b", headSha: "h" },
  tier: "lite", verdict: "approved", summary: "", coverage: [], findings: [], unverifiedCriticals: 0,
  refuted: [], remembered: [], tasks: [], skipped: [], bundles: [], usage: zero, warnings: [],
  ...fields });
`;
