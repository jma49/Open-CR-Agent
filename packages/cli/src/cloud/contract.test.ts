import { readFileSync, writeFileSync } from "node:fs";
import * as contract from "@open-cr-agent/cloud-contract";
import {
  CALL_FAILURES,
  type CoverageEntry,
  EFFORT_LEVELS,
  type Effort,
  FINDING_FATES,
  FIX_REJECTIONS,
  type Finding,
  GUIDELINE_SCOPES,
  MODEL_TIERS,
  REVIEW_STAGES,
  type ReviewTrace,
  type RiskTier,
  type TaskStatus,
  type Verdict,
} from "@open-cr-agent/core";
import {
  AGENT_ROLES,
  CHECK_LIMITS,
  logTail,
  MARKDOWN_RULES_PATH,
  MAX_MARKDOWN_RULES_CHARS,
  MAX_TIMER_MS,
  MEND_ITEM_OUTCOMES,
  MEND_ITEM_REASONS,
  MEND_LEVELS,
  MEND_OUTCOMES,
  type MendState,
  RISK_TIERS,
  ROUND_STOPS,
  severitySchema,
  verificationSchema,
} from "@open-cr-agent/core/internal";
import { priorFinding, reviewReport, taskOutcome, usage } from "@open-cr-agent/test-support";
import { describe, expect, it } from "vitest";
import { parseAccountPlugins } from "../plugins/account.js";
import { parseAccountSettings } from "./account-settings.js";
import { parseAccountMemory } from "./memory.js";
import { cloudUpload } from "./review.js";

// The fixtures in @open-cr-agent/cloud-contract are what ocra Cloud tests
// its side against (its generated copy, pinned to an engine commit). These
// tests tie them to what this CLI really sends and reads, so a change of
// shape here fails until the fixture changes, and then fails ocra Cloud's
// drift check until it takes the new contract.

const fixture = (name: string) =>
  new URL(`../../../cloud-contract/fixtures/${name}`, import.meta.url);
const read = (name: string) => JSON.parse(readFileSync(fixture(name), "utf8"));

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

describe("the contract's vocabulary", () => {
  it("is the engine's own", () => {
    const verdicts: Same<Verdict, contract.Verdict> = true;
    const tiers: Same<RiskTier, contract.RiskTier> = true;
    const efforts: Same<Effort, contract.Effort> = true;
    const files: Same<CoverageEntry["status"], contract.FileStatus> = true;
    const tasks: Same<TaskStatus, contract.TaskStatus> = true;
    const mendStates: Same<MendState, contract.MendState> = true;
    expect([verdicts, tiers, efforts, files, tasks, mendStates]).toEqual(Array(6).fill(true));
    expect(contract.RISK_TIERS).toEqual(RISK_TIERS);
    expect(contract.SEVERITIES).toEqual(severitySchema.options);
    expect(contract.VERIFICATIONS).toEqual(verificationSchema.options);
    expect(contract.EFFORTS).toEqual(EFFORT_LEVELS);
    expect(contract.MODEL_TIERS).toEqual(MODEL_TIERS);
    expect(contract.AGENT_ROLES).toEqual(AGENT_ROLES);
    expect(contract.STAGES).toEqual(REVIEW_STAGES);
    expect(contract.FINDING_FATES).toEqual(FINDING_FATES);
    expect(contract.GUIDELINE_SCOPES).toEqual(GUIDELINE_SCOPES);
    expect(contract.FIX_REJECTIONS).toEqual(FIX_REJECTIONS);
    expect(contract.FIX_FAILURE_CAUSES).toEqual(CALL_FAILURES);
    expect(contract.MEND_LEVELS).toEqual(MEND_LEVELS);
    expect(contract.MEND_OUTCOMES).toEqual(MEND_OUTCOMES);
    expect(contract.MEND_STOPS).toEqual(ROUND_STOPS);
    expect(contract.MEND_ITEM_OUTCOMES).toEqual(MEND_ITEM_OUTCOMES);
    expect(contract.MEND_ITEM_REASONS).toEqual(MEND_ITEM_REASONS);
    expect(contract.MAX_MEND_CHECKS).toBe(CHECK_LIMITS.checks);
    expect(contract.CHECK_LOG_LIMITS).toEqual({
      lines: CHECK_LIMITS.logLines,
      chars: CHECK_LIMITS.logChars,
    });
    const logs = [
      "",
      "2026-11-23T10:00:01.1234567Z \u001b[32m✓\u001b[0m adds\n\n2026-11-23T10:00:02Z \u001b[31mFAIL\u001b[0m a.test.ts\r\n  expected 6 to be 5\u0007\u2028",
      Array.from({ length: 500 }, (_, n) => `2026-11-23T10:00:02+08:00 line ${n}\t\u009b`).join(
        "\n",
      ),
      `${"x".repeat(50_000)}\nthe end`,
      "##[group]Run npm ci\nok\n##[group]Run npm test\nFAIL a.test.ts\n##[error]Process completed with exit code 1.\nPost job cleanup.",
      "section_start:1:step_script\r\u001b[0K$ npm test\nFAIL a\nsection_end:2:step_script\r\u001b[0K\nsection_start:3:after_script\r\u001b[0Kupload",
    ];
    for (const log of logs) expect(contract.checkLogTail(log)).toBe(logTail(log));
    expect(contract.MAX_TIMEOUT_MINUTES).toBe(Math.floor(MAX_TIMER_MS / 60_000));
    expect(contract.RULES_MARKDOWN_PATH).toBe(MARKDOWN_RULES_PATH);
    expect(contract.MAX_RULES_MARKDOWN_CHARS).toBe(MAX_MARKDOWN_RULES_CHARS);
  });
});

function finding(overrides: Partial<Finding>): Finding {
  return {
    id: "id",
    fingerprint: "0123456789abcdef",
    reviewer: "security",
    category: "security",
    severity: "critical",
    file: "src/db.ts",
    existingCode: "const q = 'SELECT * FROM t WHERE id = ' + id;",
    title: "SQL built from input",
    body: "The id reaches the query unescaped.",
    evidence: [],
    provenance: { task: "t1" },
    anchor: { method: "hunk", inDiff: true },
    status: "new",
    lineRange: { start: 10, end: 12 },
    verification: "confirmed",
    ...overrides,
  };
}

const { lineRange: _, ...fileLevel } = finding({
  fingerprint: "fedcba9876543210",
  reviewer: "logic",
  category: "correctness",
  severity: "warning",
  file: "src/retry.ts",
  existingCode: "while (true) await attempt();",
  title: "Retry without a limit",
  body: "A failing call is retried forever.",
  suggestion: "Stop after three attempts.",
  verification: "uncertain",
});

const { verification: _v, ...unchecked } = finding({
  fingerprint: "1111222233334444",
  severity: "suggestion",
});

const report = reviewReport({
  runId: "run-2026-10-04-a1b2",
  changeRequest: {
    id: "42",
    title: "t",
    description: "",
    baseSha: "1".repeat(40),
    headSha: "2".repeat(40),
  },
  tier: "full",
  verdict: "significant_concerns",
  findings: [
    finding({
      fix: { startLine: 10, endLine: 12, replacement: "const q = db.query(sql, [id]);" },
      evidence: ["`id` comes from `req.params` in `src/routes.ts`"],
      rule: { kind: "rule", id: "parameterized-sql" },
    }),
    fileLevel,
    unchecked,
  ],
  coverage: [
    { path: "src/db.ts", status: "reviewed" },
    { path: "src/retry.ts", status: "reviewed" },
    { path: "src/huge.ts", status: "unreviewed" },
  ],
  tasks: [
    taskOutcome({ reviewer: "security", status: "completed", usage: usage({ costUsd: 0.25 }) }),
    taskOutcome({ reviewer: "logic", status: "completed", usage: usage({ costUsd: 0.125 }) }),
    taskOutcome({ reviewer: "logic", status: "timed_out", usage: usage({ costUsd: 0.0625 }) }),
  ],
  rereview: {
    fixed: [
      priorFinding({
        fingerprint: "aaaabbbbccccdddd",
        title: "t",
        file: "a.ts",
        reviewer: "logic",
      }),
    ],
    dismissed: [
      priorFinding({
        fingerprint: "eeeeffff00001111",
        title: "t",
        file: "b.ts",
        reviewer: "security",
      }),
    ],
    notReproduced: [],
    notRechecked: [],
    unchanged: [],
  },
  unverifiedCriticals: 0,
  provenance: {
    ocraVersion: "0.0.0",
    promptHash: "0123456789abcdef",
    configHash: "fedcba9876543210",
    sampling: {},
    rules: [
      {
        id: "parameterized-sql",
        path: ["src/db/**"],
        rule: "Queries take parameters, never strings built from input.",
        source: "account",
      },
      { id: "no-inline-styles", path: ["web/**"], rule: "No inline styles.", source: "repository" },
    ],
  },
  linkedTasks: [
    {
      tracker: "github",
      key: "#41",
      url: "https://github.com/octo/app/issues/41",
      title: "Retry failed queries",
      state: "open",
      labels: ["db"],
      cut: false,
    },
  ],
  walkthrough: {
    overview:
      "Retries failed queries once, with the token api_key=sk-live-0123456789abcdef in a log.",
    groups: [
      {
        title: "Retries",
        files: ["src/retry.ts", "src/db.ts"],
        note: "Wraps the query in a retry.",
      },
    ],
    diagram: "sequenceDiagram\n  App->>DB: query\n  DB-->>App: timeout",
  },
  learnings: [
    {
      id: "retry-budget",
      title: "Retries share one budget",
      critical: false,
      bundles: ["src/retry.ts"],
    },
  ],
  mergeChecks: [
    {
      id: "chk_7.1732270000",
      instruction: "A change to retries says how often it retries in the description.",
      outcome: "failed",
      reason: "The description does not say how many times src/retry.ts retries a query.",
    },
  ],
  trace: sampleTrace(),
  usage: usage({ inputTokens: 1200, outputTokens: 340, costUsd: 0.4375 }),
});

// A review of three tasks laid out in time, as the trace of the report above.
function sampleTrace(): ReviewTrace {
  const spent = (costUsd: number) => usage({ inputTokens: 400, outputTokens: 90, costUsd });
  const attempt = (model: string, startMs: number, ms: number, read: string[]) => ({
    model,
    startMs,
    ms,
    steps: 6,
    tools: { read_file: read.length, code_search: 2, report_finding: 1, task_done: 1 },
    ending: "done" as const,
    read,
    searches: 2,
    usage: spent(0.06),
  });
  return {
    startedAt: "2026-10-04T09:12:03.000Z",
    ms: 61_234,
    stages: [
      { stage: "select", startMs: 0, ms: 40 },
      { stage: "bundle", startMs: 40, ms: 15 },
      { stage: "plan", startMs: 55, ms: 2_900 },
      { stage: "review", startMs: 2_955, ms: 41_000 },
      { stage: "filter", startMs: 43_955, ms: 20 },
      { stage: "verify", startMs: 43_975, ms: 9_800 },
      { stage: "judge", startMs: 53_775, ms: 7_459 },
    ],
    tasks: [
      {
        id: "security-1",
        reviewer: "security",
        bundle: "src/db.ts",
        files: ["src/db.ts"],
        status: "completed",
        startMs: 2_960,
        ms: 24_100,
        usage: spent(0.25),
        attempts: [
          attempt("anthropic/claude-sonnet-5-5", 2_961, 24_000, ["src/db.ts", "src/routes.ts"]),
        ],
      },
      {
        id: "logic-1",
        reviewer: "logic",
        bundle: "src/retry.ts",
        files: ["src/retry.ts"],
        status: "completed",
        startMs: 2_962,
        ms: 18_300,
        usage: spent(0.125),
        attempts: [attempt("anthropic/claude-sonnet-5-5", 2_963, 18_200, ["src/retry.ts"])],
      },
      {
        id: "logic-2",
        reviewer: "logic",
        bundle: "src/huge.ts",
        files: ["src/huge.ts"],
        status: "timed_out",
        startMs: 2_964,
        ms: 40_990,
        usage: spent(0.0625),
        attempts: [
          {
            ...attempt("anthropic/claude-sonnet-5-5", 2_965, 12_000, ["src/huge.ts"]),
            ending: "error",
          },
          { ...attempt("openai/gpt-5.2", 15_100, 28_850, ["src/huge.ts"]), ending: "step_cap" },
        ],
      },
    ],
    calls: [
      {
        agent: "logic",
        stage: "plan",
        model: "anthropic/claude-sonnet-5-5",
        startMs: 60,
        ms: 2_880,
        usage: spent(0.02),
      },
      {
        agent: "writer",
        stage: "review",
        model: "anthropic/claude-haiku-5-5",
        startMs: 2_970,
        ms: 6_400,
        usage: spent(0.004),
      },
      {
        agent: "verifier",
        stage: "verify",
        model: "anthropic/claude-sonnet-5-5",
        startMs: 43_980,
        ms: 9_790,
        usage: spent(0.03),
      },
      {
        agent: "judge",
        stage: "judge",
        model: "anthropic/claude-opus-5-5",
        startMs: 53_780,
        ms: 7_450,
        usage: spent(0.09),
      },
    ],
    findings: [
      {
        fingerprint: "0123456789abcdef",
        taskId: "security-1",
        reviewer: "security",
        severity: "critical",
        file: "src/db.ts",
        line: 10,
        title: "SQL built from request input",
        atMs: 20_400,
        fate: "kept",
      },
      {
        fingerprint: "fedcba9876543210",
        taskId: "logic-1",
        reviewer: "logic",
        severity: "warning",
        file: "src/retry.ts",
        title: "Retry without a limit",
        atMs: 17_800,
        fate: "kept",
        recalibrated: { from: "critical", to: "warning", reason: "Only a background job retries." },
      },
      {
        fingerprint: "5555666677778888",
        taskId: "logic-1",
        reviewer: "logic",
        severity: "warning",
        file: "src/retry.ts",
        line: 4,
        title: "Timeout not passed to the query",
        atMs: 19_100,
        fate: "refuted",
        reason: "query() reads the timeout from the pool's options, set in src/db.ts.",
      },
      {
        fingerprint: "9999aaaabbbbcccc",
        taskId: "security-1",
        reviewer: "security",
        severity: "suggestion",
        file: "src/db.ts",
        title: "Log the token api_key=sk-live-0123456789abcdef less often",
        atMs: 21_000,
        fate: "dropped",
        reason: "Restates the critical finding on the same line.",
      },
      {
        taskId: "logic-1",
        file: "src/queue.ts",
        title: "Queue drains twice",
        atMs: 18_000,
        fate: "outside_review",
      },
    ],
  };
}

describe("the contract's fixtures", () => {
  it("upload.json is what this CLI sends", () => {
    const { upload, shared } = cloudUpload(
      report,
      {
        repository: "https://github.com/octo/app",
        repoHash: "8d969eef6ecad3c29a3a629280e686cf0c3f5d5a86aff3ca12020c923adc6c92",
        shareFindings: true,
      },
      { source: "github", durationMs: 61_234.4, changeRequestNumber: 42, shareRepoName: true },
    );
    const sent = {
      about: read("upload.json").about,
      ...upload,
      // Not this CLI's version: the fixture would change with every release.
      ocraVersion: "0.0.0",
      findingList: shared?.findings,
    };
    // OCRA_UPDATE_FIXTURES=1 rewrites it; then npm run format.
    if (process.env.OCRA_UPDATE_FIXTURES) {
      writeFileSync(fixture("upload.json"), `${JSON.stringify(sent, null, 2)}\n`);
    }
    expect(sent).toEqual(read("upload.json"));
  });

  it("preferences.json is read whole, with no warning", () => {
    const { answer } = read("preferences.json");
    const { settings, warnings } = parseAccountSettings(answer);
    expect(warnings).toEqual([]);
    expect(Object.keys(settings).sort()).toEqual(
      [
        "version",
        "runtime",
        "models",
        ...Object.keys(answer.agents),
        ...Object.keys(answer.settings).filter((k) => k !== "plugins" && k !== "pluginSettings"),
      ].sort(),
    );
    const warned: string[] = [];
    expect(parseAccountPlugins(answer, (w) => warned.push(w))).toEqual({
      plugins: answer.settings.plugins,
      pluginSettings: answer.settings.pluginSettings,
    });
    expect(warned).toEqual([]);
  });

  it("memory.json is applied whole", () => {
    const { answer } = read("memory.json");
    expect(contract.memoryAnswerSchema.parse(answer)).toEqual(answer);
    const warned: string[] = [];
    expect(parseAccountMemory(answer.entries, (w) => warned.push(w))).toHaveLength(
      answer.entries.length,
    );
    expect(warned).toEqual([]);
  });
});
