import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Instance } from "./instance.js";

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

// What providers answer when they refuse, as a task's error carries it
// ("every standard model failed (<model>: <message>)").
export const REFUSALS = {
  // Anthropic, HTTP 400 invalid_request_error.
  credit:
    "anthropic/claude-haiku-5-5: Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.",
  // Anthropic, a workspace's monthly spend limit.
  "spend-limit":
    "anthropic/claude-haiku-5-5: You have reached your specified workspace API usage limits. You will regain access on 2026-11-01 at 00:00 UTC.",
  // Anthropic, HTTP 429 rate_limit_error.
  "per-minute":
    "anthropic/claude-haiku-5-5: This request would exceed the rate limit for your organization of 50,000 input tokens per minute. Please reduce the prompt length or try again later.",
  // Anthropic, HTTP 529 overloaded_error.
  overloaded: "anthropic/claude-haiku-5-5: Overloaded",
  // Vertex AI's shared quota, from a run it cut short.
  vertex:
    'vertex/google/gemini-3.5-flash: HTTP 429: [{ "error": { "code": 429, "message": "Resource exhausted. Please try again later. Please refer to https://cloud.google.com/vertex-ai/generative-ai/docs/error-code-429 for more details.", "status": "RESOURCE_EXHAUSTED" } } ]',
} as const;

// Stands in for `ocra review`, by the base commit: a report with one finding
// at src/a.ts:10 costing $0.5 by default; "fail" fails; "refused:<refusal>"
// fails every task on that refusal and "lost:<refusal>" one of them (with
// another lost to the runtime giving up on the model); "spend-cap" is cut by
// the per-PR spend cap and a task's timeout, "run-timeout" by ocra's run
// timeout; "slow" outlives the PR's timeout. With --temperature, the report
// records its provenance, one agent on anthropic/claude-haiku-5-5. The base
// of every call is logged in calls.log.
export function fakeOcra(dir: string): string {
  const script = join(dir, "fake-ocra.mjs");
  writeFileSync(
    script,
    `import { writeFileSync, appendFileSync, mkdirSync } from "node:fs";
${FAKE_REPORT_JS}
const REFUSALS = ${JSON.stringify(REFUSALS)};
const args = process.argv.slice(2);
const out = args[args.indexOf("--output") + 1];
const from = args[args.indexOf("--from") + 1];
appendFileSync(${JSON.stringify(join(dir, "calls.log"))}, from + "\\n");
// A session log where ocra keeps one, under the run id the report names.
if (from.startsWith("session:")) {
  const runId = from.slice("session:".length);
  mkdirSync(".ocra/sessions/" + runId, { recursive: true });
  writeFileSync(".ocra/sessions/" + runId + "/events.jsonl", '{"type":"run_started"}\\n');
  writeFileSync(out, JSON.stringify(report({ runId, tasks: [task("correctness-1", "completed")] })));
  process.exit(0);
}
// A review that lost a task to the quota, with its session; resumed, it
// completes the rest. The resumed run ids are logged.
if (from === "resumable") {
  const resume = args.indexOf("--resume");
  const runId = resume < 0 ? "run-1" : "run-2";
  if (resume >= 0) appendFileSync(${JSON.stringify(join(dir, "resumed.log"))}, args[resume + 1] + "\\n");
  mkdirSync(".ocra/sessions/" + runId, { recursive: true });
  // What each task read; the lost task of run-1 read src/lost.ts.
  const events = [{ type: "run_started", runId },
    { type: "task_progress", taskId: "performance-1", message: "", attempt: { read: ["src/perf.ts"] } },
    { type: "task_reported", taskId: "performance-1", key: "k-perf", findings: [] },
    { type: "task_progress", taskId: "correctness-1", message: "", attempt: { read: [resume < 0 ? "src/lost.ts" : "src/redone.ts"] } }];
  if (resume >= 0) events.splice(1, 1, { type: "task_finished", outcome: { taskId: "performance-1", reusedFrom: "run-1" } });
  writeFileSync(".ocra/sessions/" + runId + "/events.jsonl", events.map((e) => JSON.stringify(e) + "\\n").join(""));
  const tasks = resume < 0
    ? [task("performance-1", "completed"), task("correctness-1", "failed", "out of quota for this run")]
    : [{ ...task("performance-1", "completed"), reusedFrom: "run-1" }, task("correctness-1", "completed")];
  writeFileSync(out, JSON.stringify(report({ runId, tasks,
    usage: { ...zero, costUsd: resume < 0 ? 0.3 : 0.2 } })));
  process.exit(resume < 0 ? 3 : 0);
}
if (from === "fail") { process.stderr.write("boom\\n"); process.exit(2); }
if (from === "quota") {
  writeFileSync(out, JSON.stringify(report({ tasks: [task("correctness-1", "failed",
    "every standard model failed (google/x: You exceeded your current quota, please check your plan)")] })));
  process.exit(2);
}
if (from === "cut") {
  writeFileSync(out, JSON.stringify(report({ tasks: [task("performance-1", "completed"),
    task("correctness-1", "failed",
      "every standard model failed (router/m: Rate limit exceeded: free-models-per-day-stealth.)")],
    usage: { ...zero, inputTokens: 50, outputTokens: 5 } })));
  process.exit(3);
}
if (from.startsWith("refused:")) {
  const error = "every standard model failed (" + REFUSALS[from.slice("refused:".length)] + ")";
  writeFileSync(out, JSON.stringify(report({ tasks: [task("correctness-1", "failed", error),
    task("security-1", "failed", error)] })));
  process.stderr.write("[ocra] No review task completed; see the errors above.\\n");
  process.exit(2);
}
if (from.startsWith("lost:")) {
  writeFileSync(out, JSON.stringify(report({ tasks: [task("performance-1", "completed"),
    task("correctness-1", "failed", "every standard model failed (" + REFUSALS[from.slice("lost:".length)] + ")"),
    task("docs-1", "failed", "every light model is out of quota for this run")] })));
  process.exit(3);
}
if (from === "spend-cap") {
  writeFileSync(out, JSON.stringify(report({ spendLimit: { usd: 2, reached: "review" },
    tasks: [task("correctness-1", "completed"),
      task("performance-1", "cancelled", "stopped at the spend limit of $2"),
      task("docs-1", "cancelled", "spend limit of $2 reached"),
      task("security-1", "timed_out", "timed out after 600000ms")] })));
  process.exit(3);
}
if (from === "run-timeout") {
  writeFileSync(out, JSON.stringify(report({ tasks: [task("correctness-1", "completed"),
    task("performance-1", "cancelled", "run cancelled"),
    task("docs-1", "cancelled", "run cancelled before this task started")] })));
  process.exit(3);
}
// Stopped by the PR's timeout, ocra writes what it has, as on Ctrl-C.
if (from === "slow") {
  process.on("SIGTERM", () => {
    writeFileSync(out, JSON.stringify(report({ tasks: [task("correctness-1", "completed")] })));
    process.exit(130);
  });
  setTimeout(() => process.exit(0), 20_000);
} else if (from === "steps") {
  writeFileSync(out, JSON.stringify(report({ tasks: [{ ...task("correctness-1", "completed"), ended: "step_cap" }] })));
  process.exit(3);
} else {
  const finding = { fingerprint: "f", reviewer: "correctness", category: "correctness", severity: "warning",
    verification: "unchecked", file: "src/a.ts", code: "x", title: "Null dereference", body: "user may be missing",
    evidence: [], lines: { start: 10, end: 10 }, inDiff: true, status: "new" };
  const t = args.indexOf("--temperature");
  const provenance = t < 0 ? {} : { provenance: { ocraVersion: "9.9.9", promptHash: "p1", configHash: "c1",
    sampling: { temperature: Number(args[t + 1]), notApplied: ["seed"] },
    agents: { correctness: { tier: "standard", models: ["anthropic/claude-haiku-5-5"] } } } };
  writeFileSync(out, JSON.stringify(report({ findings: [finding], tasks: [task("correctness-1", "completed")],
    usage: { ...zero, inputTokens: 100, outputTokens: 10, costUsd: 0.5 }, ...provenance })));
  // Interrupted after one task finished: a partial report and exit 130.
  if (from === "interrupted") process.exit(130);
}
`,
  );
  chmodSync(script, 0o755);
  return script;
}

// A PR for the fake ocra, reviewed as the base commit says; two references.
export function instance(id: string, baseCommit = "base"): Instance {
  return {
    id,
    repo: "acme/api",
    prUrl: "https://github.com/acme/api/pull/1",
    language: "TypeScript",
    prCategory: "Bug Fix",
    baseCommit,
    headCommit: "head",
    changeLines: 10,
    references: [
      {
        path: "src/a.ts",
        side: "right",
        fromLine: 10,
        toLine: 11,
        note: "Null dereference",
        category: "Code Defect",
        context: "Diff Level",
      },
      {
        path: "src/b.ts",
        side: "right",
        fromLine: 1,
        toLine: 1,
        note: "Missing await",
        category: "Code Defect",
        context: "File Level",
      },
    ],
  };
}
