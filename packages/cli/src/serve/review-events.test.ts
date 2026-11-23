import { readFileSync, writeFileSync } from "node:fs";
import { readReviewEvent } from "@open-cr-agent/cloud-contract";
import type { ReviewEvent } from "@open-cr-agent/core";
import { finding, reviewReport, taskOutcome, usage } from "@open-cr-agent/test-support";
import { describe, expect, it } from "vitest";
import { ReviewEventMapper } from "./review-events.js";

const fixture = new URL("../../../cloud-contract/fixtures/events.json", import.meta.url);
const read = () => JSON.parse(readFileSync(fixture, "utf8"));

const runId = "run-2026-11-21-c3d4";
const found = finding({
  id: "f1",
  fingerprint: "a1b2c3d4e5f60718",
  reviewer: "security",
  category: "security",
  severity: "critical",
  file: "src/auth/session.ts",
  lineRange: { start: 42, end: 44 },
  title: "Session token compared with ===",
  body: "The comparison returns early on the first differing byte, so its timing tells an attacker how much of a guessed token is right.",
  suggestion: "Compare with crypto.timingSafeEqual on equal-length buffers.",
});
const merged = finding({
  ...found,
  id: "f2",
  title: "Token compared twice",
  lineRange: { start: 50, end: 50 },
});
const task = taskOutcome({
  taskId: "security-1",
  reviewer: "security",
  files: ["src/auth/session.ts", "src/auth/session.test.ts"],
});
const coverage = [
  { path: "src/auth/session.ts", status: "reviewed" as const },
  { path: "src/auth/session.test.ts", status: "failed" as const },
  { path: "package-lock.json", status: "excluded" as const, reason: "generated" as const },
];
const spent = usage({
  inputTokens: 18_200,
  cachedTokens: 12_000,
  outputTokens: 900,
  reasoningTokens: 400,
  costUsd: 0.041,
});
const report = reviewReport({
  runId,
  verdict: "significant_concerns",
  coverage,
  tasks: [task],
  findings: [{ ...found, verification: "confirmed" }],
  warnings: ["1 file not reviewed: src/auth/session.test.ts"],
  usage: spent,
});

const run: ReviewEvent[] = [
  { type: "run_started", runId, changeRequest: report.changeRequest },
  { type: "stage_started", stage: "select" },
  { type: "files_selected", selected: 2, excluded: 1, tier: "full" },
  { type: "stage_started", stage: "review" },
  {
    type: "task_started",
    taskId: task.taskId,
    reviewer: "security",
    bundle: "b",
    files: task.files,
  },
  { type: "finding", taskId: task.taskId, finding: found },
  { type: "finding", taskId: task.taskId, finding: merged },
  { type: "usage_reported", usage: spent },
  { type: "task_finished", outcome: task },
  {
    type: "findings_verified",
    file: found.file,
    kept: [{ ...found, verification: "confirmed" }],
    refuted: [],
    settled: [found.id],
  },
  { type: "stage_started", stage: "filter" },
  { type: "coverage_settled", coverage },
  { type: "stage_started", stage: "verify" },
  { type: "run_finished", report },
];

function mapped() {
  let clock = Date.parse("2026-11-21T08:00:00.000Z");
  const mapper = new ReviewEventMapper(runId, "workspace", () => (clock += 100));
  return run.flatMap((e) => mapper.map(e));
}

describe("the live events of a run", () => {
  it("are the contract's events.json", () => {
    const { about, events } = read();
    const live = mapped();
    const newer = { ...events.at(-1), seq: live.length + 1, at: live.at(-1)?.at };
    const written = { about, events: [...live, newer] };
    // OCRA_UPDATE_FIXTURES=1 rewrites it; then npm run format.
    if (process.env.OCRA_UPDATE_FIXTURES) {
      writeFileSync(fixture, `${JSON.stringify(written, null, 2)}\n`);
    }
    expect(written).toEqual(read());
  });

  it("send a finding again once verified and at the end, and mark the ones the judge dropped", () => {
    const findings = mapped().filter((e) => e.kind === "finding");
    expect(
      findings.map((e) => [e.data.id, e.data.verification, e.data.settled, e.data.dropped]),
    ).toEqual([
      ["f1", undefined, undefined, undefined],
      ["f2", undefined, undefined, undefined],
      ["f1", "confirmed", true, undefined],
      ["f1", "confirmed", true, undefined],
      ["f2", undefined, undefined, true],
    ]);
  });

  it("mark a finding the verifier refuted while tasks still ran as dropped", () => {
    const mapper = new ReviewEventMapper(runId, "workspace");
    mapper.map({ type: "finding", taskId: task.taskId, finding: merged });
    const [dropped] = mapper.map({
      type: "findings_verified",
      file: merged.file,
      kept: [],
      refuted: [merged.id],
      settled: [],
    });
    expect(dropped).toMatchObject({ kind: "finding", data: { id: merged.id, dropped: true } });
  });

  it("give one file.finished per file, and end with finished", () => {
    const events = mapped();
    expect(events.filter((e) => e.kind === "file.finished").map((e) => e.data.status)).toEqual([
      "reviewed",
      "failed",
      "excluded",
    ]);
    expect(events.at(-1)).toMatchObject({
      kind: "finished",
      data: { verdict: "significant_concerns", complete: false },
    });
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i + 1));
    for (const e of events) expect(readReviewEvent(e)).toEqual(e);
  });

  it("number the failure after what came before", () => {
    const mapper = new ReviewEventMapper(runId, "workspace");
    mapper.map(run[0] as ReviewEvent);
    expect(mapper.failed("cancelled")).toMatchObject({
      seq: 2,
      kind: "failed",
      data: { reason: "cancelled" },
    });
  });
});
