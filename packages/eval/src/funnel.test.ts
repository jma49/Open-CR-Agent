import { copyFile, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Finding, ReviewEvent } from "@open-cr-agent/core";
import { serializeOutput } from "@open-cr-agent/core/internal";
import { describe, expect, it } from "vitest";
import { writeSummary } from "./commands/summary.js";
import { base, finding, reviewed } from "./golden.fakes.js";
import { parseCase, toInstance } from "./golden.js";
import { scoreGolden } from "./golden-score.js";
import { createJudge, MockJudge } from "./judges.js";
import { renderMarkdown } from "./report.js";
import { score } from "./score.js";
import { readSessionTrace, sessionLogPath } from "./session-trace.js";

const CONCERNS = {
  found: "The session token is never cleared on logout",
  dropped: "The retry loop never stops while the server keeps failing",
  raised: "The cache key ignores the tenant so tenants share entries",
  looked: "The parser accepts a negative page size",
  missed: "The lock is released before the write is flushed",
} as const;
type Stage = keyof typeof CONCERNS;

const kase = toInstance(
  parseCase(
    {
      ...base,
      id: "funnel",
      expect: Object.entries(CONCERNS).map(([stage, concern]) => ({
        file: `src/${stage}.ts`,
        lines: [10, 12],
        category: "correctness",
        minSeverity: "warning",
        concern,
      })),
    },
    "funnel.json",
  ),
);

// A finding as a review task reports it, before Verify and the judge.
function raisedOn(stage: Stage, fingerprint: string): Finding {
  return {
    id: fingerprint,
    fingerprint,
    reviewer: "correctness",
    category: "correctness",
    severity: "warning",
    file: `src/${stage}.ts`,
    lineRange: { start: 11, end: 11 },
    existingCode: "x",
    title: CONCERNS[stage],
    body: "See the change.",
    evidence: [],
    provenance: { task: "correctness-1" },
    anchor: { method: "hunk", inDiff: true },
    status: "new",
  };
}

// What the session log of the review would hold, written the way core's
// session writer writes it.
async function recorded(events: ReviewEvent[]): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ocra-funnel-"));
  const path = join(dir, "events.jsonl");
  const lines = events.map((e) => serializeOutput({ time: "2026-10-08T00:00:00Z", ...e }, 0));
  await writeFile(path, `${lines.join("\n")}\n`);
  return path;
}

const taskId = "correctness-1";
const session: ReviewEvent[] = [
  {
    type: "task_started",
    taskId,
    reviewer: "correctness",
    bundle: "b",
    files: Object.keys(CONCERNS).map((s) => `src/${s}.ts`),
  },
  {
    type: "task_progress",
    taskId,
    message: "m: 4 step(s)",
    attempt: {
      model: "m",
      read: ["./src/looked.ts", "src/dropped.ts"],
      searched: ["tenant"],
      text: "",
    },
  },
  { type: "finding", taskId, finding: raisedOn("found", "000000000000000f") },
  { type: "finding", taskId, finding: raisedOn("dropped", "000000000000000d") },
  { type: "finding", taskId, finding: raisedOn("raised", "000000000000000r") },
  {
    type: "verification_finished",
    checked: 3,
    refuted: [
      {
        fingerprint: "000000000000000d",
        file: "src/dropped.ts",
        title: CONCERNS.dropped,
        reason: "The loop is capped.",
      },
    ],
  },
];

const report = reviewed("funnel", [
  finding("000000000000000f", {
    file: "src/found.ts",
    lines: { start: 11, end: 11 },
    title: CONCERNS.found,
    body: "See the change.",
  }),
]);

describe("the recall funnel", () => {
  it("records how far each expected finding got, from the session events", async () => {
    const trace = await readSessionTrace(await recorded(session));
    if (!trace) throw new Error("no trace");
    const summary = await scoreGolden(
      [kase],
      [report],
      new MockJudge(),
      new Map([["funnel", trace]]),
    );
    expect(summary.cases?.funnel?.claims).toEqual([
      { concern: CONCERNS.found, found: true, stage: "found" },
      { concern: CONCERNS.dropped, found: false, stage: "dropped", droppedBy: "verify" },
      { concern: CONCERNS.raised, found: false, stage: "raised" },
      { concern: CONCERNS.looked, found: false, stage: "looked" },
      { concern: CONCERNS.missed, found: false, stage: "not-looked" },
    ]);
    expect(summary.funnel).toEqual({
      "not-looked": 1,
      looked: 1,
      raised: 1,
      dropped: 1,
      found: 1,
      unknown: 0,
    });
    const markdown = renderMarkdown(
      { runId: "r", createdAt: "c", selection: {}, models: {}, judge: "mock" },
      { ...(await score([], [], new MockJudge())), golden: summary },
    );
    expect(markdown).toContain("| 1 | 1 | 1 | 1 | 1 | 0 |");
    expect(markdown).toContain(`- funnel#2 (dropped by verify): ${CONCERNS.dropped}`);
    expect(markdown).toContain(`- funnel#5 (not-looked): ${CONCERNS.missed}`);
  });

  it("counts a finding dropped outside its task's bundle, or by the judge, as dropped", async () => {
    const trace = await readSessionTrace(
      await recorded([
        ...session.slice(0, 4),
        {
          type: "finding_dropped",
          taskId,
          reason: "outside_bundle",
          file: "src/raised.ts",
          title: CONCERNS.raised,
        },
        {
          type: "judge_finished",
          verdict: "approved",
          judgement: {
            merged: [],
            dropped: [
              {
                fingerprint: "000000000000000d",
                file: "src/dropped.ts",
                title: CONCERNS.dropped,
                reason: "Speculative.",
              },
            ],
            recalibrated: [],
          },
        },
      ]),
    );
    if (!trace) throw new Error("no trace");
    const summary = await scoreGolden(
      [kase],
      [report],
      new MockJudge(),
      new Map([["funnel", trace]]),
    );
    expect(summary.cases?.funnel?.claims.slice(1, 3)).toEqual([
      { concern: CONCERNS.dropped, found: false, stage: "dropped", droppedBy: "judge" },
      { concern: CONCERNS.raised, found: false, stage: "dropped", droppedBy: "outside_bundle" },
    ]);
  });

  it("counts a finding the judge merged into another as dropped by the judge", async () => {
    const trace = await readSessionTrace(
      await recorded([
        ...session,
        {
          type: "judge_finished",
          verdict: "approved",
          judgement: {
            merged: [{ kept: "000000000000000f", merged: ["000000000000000r"] }],
            dropped: [],
            recalibrated: [],
          },
        },
      ]),
    );
    if (!trace) throw new Error("no trace");
    const summary = await scoreGolden(
      [kase],
      [report],
      new MockJudge(),
      new Map([["funnel", trace]]),
    );
    expect(summary.cases?.funnel?.claims[2]).toEqual({
      concern: CONCERNS.raised,
      found: false,
      stage: "dropped",
      droppedBy: "judge",
    });
  });

  it("adds no judge call to scoring", async () => {
    const trace = await readSessionTrace(await recorded(session));
    if (!trace) throw new Error("no trace");
    const counting = () => {
      const judge = new MockJudge();
      let calls = 0;
      return {
        judge: {
          sameIssue: (a: string, b: string) => {
            calls += 1;
            return judge.sameIssue(a, b);
          },
        },
        calls: () => calls,
      };
    };
    const without = counting();
    await scoreGolden([kase], [report], without.judge);
    const withFunnel = counting();
    await scoreGolden([kase], [report], withFunnel.judge, new Map([["funnel", trace]]));
    expect(withFunnel.calls()).toBe(without.calls());
  });

  it("reports the funnel as unknown, not zero, for a run that kept no session events", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ocra-funnel-"));
    expect(await readSessionTrace(join(dir, "missing.jsonl"))).toBeUndefined();
    const summary = await scoreGolden([kase], [report], new MockJudge());
    expect(summary.cases?.funnel?.claims[0]).toEqual({ concern: CONCERNS.found, found: true });
    expect(summary.funnel).toEqual({
      "not-looked": 0,
      looked: 0,
      raised: 0,
      dropped: 0,
      found: 0,
      unknown: 5,
    });
    const markdown = renderMarkdown(
      { runId: "r", createdAt: "c", selection: {}, models: {}, judge: "mock" },
      { ...(await score([], [], new MockJudge())), golden: summary },
    );
    expect(markdown).toContain("Recall funnel: unknown");
  });

  it("is read from the session logs a run kept when it is scored", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "ocra-funnel-"));
    await mkdir(join(runDir, "events"));
    await copyFile(await recorded(session), sessionLogPath(runDir, "funnel"));
    const { saved } = await writeSummary(
      runDir,
      { runId: "r", createdAt: "c", selection: { goldenDir: runDir }, models: {}, judge: "mock" },
      [kase],
      [report],
      createJudge(true, {}),
      runDir,
    );
    expect(saved.summary.golden?.funnel).toMatchObject({ found: 1, dropped: 1, unknown: 0 });
    expect(await readFile(join(runDir, "summary.md"), "utf8")).toContain("### Recall funnel");
  });

  it("refuses a session log that is not one, saying which", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ocra-funnel-"));
    const path = join(dir, "events.jsonl");
    await writeFile(path, '{"type":"finding","finding":{"file":3}}\n');
    await expect(readSessionTrace(path)).rejects.toThrow(path);
  });
});
