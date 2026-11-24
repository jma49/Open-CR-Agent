import type { AttemptRecord, Usage } from "../contracts.js";
import type { Finding, Severity } from "../domain.js";
import type { JudgeDecisions } from "../judge/judge.js";
import type { ReviewEvent, ReviewReport, ReviewStage, TaskStatus } from "./report.js";

// How a review came to its findings, laid out in time (ADR-0081): when each
// stage started, what each task and each of its attempts did and spent,
// every plain model call, and where each reported finding ended up and why.
// Times are milliseconds from the run's start. It holds no code, prompt or
// answer text: paths, counts, titles and the verifier's and judge's reasons.
export interface ReviewTrace {
  startedAt: string;
  ms: number;
  stages: TraceStage[];
  tasks: TraceTask[];
  calls: TraceCall[];
  findings: TraceFinding[];
}

export interface TraceStage {
  stage: ReviewStage;
  startMs: number;
  ms: number;
}

export interface TraceTask {
  id: string;
  reviewer: string;
  bundle: string;
  files: string[];
  status: TaskStatus;
  // Absent for a task taken from an earlier run (--resume), which this run
  // did not time.
  startMs?: number;
  ms?: number;
  reusedFrom?: string;
  usage: Usage;
  attempts: TraceAttempt[];
}

export interface TraceAttempt {
  model: string;
  startMs: number;
  ms: number;
  steps: number;
  tools: Record<string, number>;
  ending: NonNullable<AttemptRecord["ending"]>;
  // Files it read, in order; how many literals it searched for (the
  // literals are code, so the trace does not keep them).
  read: string[];
  searches: number;
  usage: Usage;
}

// One plain completion: a plan call, grouping, Verify, Judge, relocation,
// the walkthrough. stage: the one running when it started.
export interface TraceCall {
  agent: string;
  stage?: ReviewStage;
  model?: string;
  startMs: number;
  ms: number;
  usage: Usage;
  failed?: true;
}

export const FINDING_FATES = [
  "kept",
  "outside_review",
  "refuted",
  "merged",
  "dropped",
  "filtered",
] as const;
export type FindingFate = (typeof FINDING_FATES)[number];

// fate: kept in the report; reported on a file outside the review; refuted
// by Verify; merged into another (mergedInto) or dropped by the judge;
// filtered (memory, an earlier dismissal, the pre-existing switch).
export interface TraceFinding {
  // Absent for a finding dropped before it was anchored (outside_review).
  fingerprint?: string;
  taskId?: string;
  reviewer?: string;
  severity?: Severity;
  file: string;
  line?: number;
  title: string;
  atMs?: number;
  fate: FindingFate;
  reason?: string;
  mergedInto?: string;
  recalibrated?: { from: Severity; to: Severity; reason: string };
}

interface Reported {
  finding: Finding;
  taskId: string;
  atMs: number;
}

// Fed every event of one run as it is emitted; build() reads the report the
// run ended with.
export class TraceRecorder {
  private readonly started: number;
  private readonly stages: { stage: ReviewStage; startMs: number }[] = [];
  private readonly taskTimes = new Map<string, { startMs: number; endMs?: number }>();
  private readonly attempts = new Map<string, TraceAttempt[]>();
  private readonly calls: TraceCall[] = [];
  private readonly reported = new Map<string, Reported>();
  private readonly outside: TraceFinding[] = [];
  private readonly refuted = new Map<string, string | undefined>();
  private judgement: JudgeDecisions | undefined;

  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
    this.started = now();
  }

  record(event: ReviewEvent): void {
    const at = this.now() - this.started;
    switch (event.type) {
      case "stage_started":
        this.stages.push({ stage: event.stage, startMs: at });
        return;
      case "task_started":
        this.taskTimes.set(event.taskId, { startMs: at });
        return;
      case "task_progress":
        if (event.attempt) this.recordAttempt(event.taskId, event.attempt, at);
        return;
      case "task_finished": {
        const times = this.taskTimes.get(event.outcome.taskId);
        if (times) times.endMs = at;
        return;
      }
      case "model_called":
        this.calls.push({
          agent: event.agent,
          ...this.stageAt(at - event.ms),
          ...(event.model ? { model: event.model } : {}),
          startMs: Math.max(0, at - event.ms),
          ms: event.ms,
          usage: event.usage,
          ...(event.failed ? { failed: true } : {}),
        });
        return;
      case "finding":
        if (!this.reported.has(event.finding.fingerprint)) {
          this.reported.set(event.finding.fingerprint, {
            finding: event.finding,
            taskId: event.taskId,
            atMs: at,
          });
        }
        return;
      case "finding_dropped":
        this.outside.push({
          taskId: event.taskId,
          file: event.file,
          title: event.title,
          atMs: at,
          fate: "outside_review",
        });
        return;
      case "findings_verified":
        for (const id of event.refuted) {
          const fingerprint = this.fingerprintOf(id);
          if (fingerprint && !this.refuted.has(fingerprint))
            this.refuted.set(fingerprint, undefined);
        }
        return;
      case "verification_finished":
        for (const r of event.refuted) this.refuted.set(r.fingerprint, r.reason);
        return;
      case "judge_finished":
        this.judgement = event.judgement;
        return;
      default:
        return;
    }
  }

  build(report: Pick<ReviewReport, "tasks" | "findings">): ReviewTrace {
    const ms = this.now() - this.started;
    return {
      startedAt: new Date(this.started).toISOString(),
      ms,
      stages: this.stages.map((s, i) => ({
        ...s,
        ms: (this.stages[i + 1]?.startMs ?? ms) - s.startMs,
      })),
      tasks: report.tasks.map((t) => {
        const times = this.taskTimes.get(t.taskId);
        return {
          id: t.taskId,
          reviewer: t.reviewer,
          bundle: t.bundle,
          files: t.files,
          status: t.status,
          ...(times ? { startMs: times.startMs, ms: (times.endMs ?? ms) - times.startMs } : {}),
          ...(t.reusedFrom ? { reusedFrom: t.reusedFrom } : {}),
          usage: t.usage,
          attempts: this.attempts.get(t.taskId) ?? [],
        };
      }),
      calls: this.calls,
      findings: [...this.outside, ...this.fates(report.findings)],
    };
  }

  private recordAttempt(taskId: string, attempt: AttemptRecord, at: number): void {
    const ms = attempt.ms ?? 0;
    const list = this.attempts.get(taskId) ?? [];
    list.push({
      model: attempt.model,
      startMs: Math.max(0, at - ms),
      ms,
      steps: attempt.steps ?? 0,
      tools: attempt.tools ?? {},
      ending: attempt.ending ?? "done",
      read: attempt.read,
      searches: attempt.searched.length,
      usage: attempt.usage ?? { ...ZERO },
    });
    this.attempts.set(taskId, list);
  }

  private stageAt(at: number): { stage?: ReviewStage } {
    const running = this.stages.findLast((s) => s.startMs <= at);
    return running ? { stage: running.stage } : {};
  }

  private fingerprintOf(id: string): string | undefined {
    for (const { finding } of this.reported.values()) {
      if (finding.id === id) return finding.fingerprint;
    }
    return undefined;
  }

  private fates(kept: readonly Finding[]): TraceFinding[] {
    const final = new Map(kept.map((f) => [f.fingerprint, f]));
    const judged = judgedFates(this.judgement);
    const traced = [...this.reported.values()].map(({ finding, taskId, atMs }) => {
      const recalibrated = judged.recalibrated.get(finding.fingerprint);
      return {
        ...findingFields(final.get(finding.fingerprint) ?? finding),
        taskId,
        atMs,
        ...this.fate(finding.fingerprint, final.has(finding.fingerprint), judged),
        ...(recalibrated ? { recalibrated } : {}),
      };
    });
    // Kept without being reported in this run: taken from an earlier run's
    // tasks (--resume).
    const seen = new Set(this.reported.keys());
    const carried = kept
      .filter((f) => !seen.has(f.fingerprint))
      .map((f) => ({ ...findingFields(f), fate: "kept" as const }));
    return [...traced, ...carried];
  }

  private fate(
    fingerprint: string,
    isKept: boolean,
    judged: ReturnType<typeof judgedFates>,
  ): Pick<TraceFinding, "fate" | "reason" | "mergedInto"> {
    if (isKept) return { fate: "kept" };
    const into = judged.merged.get(fingerprint);
    if (into) return { fate: "merged", mergedInto: into };
    const dropped = judged.dropped.get(fingerprint);
    if (dropped !== undefined) return { fate: "dropped", reason: dropped };
    if (this.refuted.has(fingerprint)) {
      const reason = this.refuted.get(fingerprint);
      return reason ? { fate: "refuted", reason } : { fate: "refuted" };
    }
    return { fate: "filtered" };
  }
}

const ZERO: Usage = {
  inputTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  cachedTokens: 0,
  costUsd: 0,
};

function findingFields(
  f: Finding,
): Pick<TraceFinding, "fingerprint" | "reviewer" | "severity" | "file" | "line" | "title"> {
  return {
    fingerprint: f.fingerprint,
    reviewer: f.reviewer,
    severity: f.severity,
    file: f.file,
    ...(f.lineRange ? { line: f.lineRange.start } : {}),
    title: f.title,
  };
}

function judgedFates(judgement: JudgeDecisions | undefined) {
  const merged = new Map<string, string>();
  const dropped = new Map<string, string>();
  const recalibrated = new Map<string, NonNullable<TraceFinding["recalibrated"]>>();
  for (const m of judgement?.merged ?? []) for (const fp of m.merged) merged.set(fp, m.kept);
  for (const d of judgement?.dropped ?? []) dropped.set(d.fingerprint, d.reason);
  for (const r of judgement?.recalibrated ?? []) {
    recalibrated.set(r.fingerprint, { from: r.from, to: r.to, reason: r.reason });
  }
  return { merged, dropped, recalibrated };
}
