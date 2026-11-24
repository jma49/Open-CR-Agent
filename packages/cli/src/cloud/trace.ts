import {
  MAX_TRACE_ATTEMPTS,
  MAX_TRACE_BYTES,
  MAX_TRACE_CALLS,
  MAX_TRACE_FINDINGS,
  MAX_TRACE_PATHS,
  MAX_TRACE_TASKS,
  MAX_TRACE_TEXT,
  redactField,
  type SharedTrace,
  sharedTraceSchema,
} from "@open-cr-agent/cloud-contract";
import type { ReviewTrace, TraceFinding, TraceTask } from "@open-cr-agent/core";

// The review's trace as an upload that shares the findings carries it
// (ADR-0081): titles, reasons and paths through the findings' redaction
// pass, every list within the contract's bounds. A trace still too large
// goes without what each attempt read; one that does not fit even then, or
// that the contract refuses, is not sent.
export function sharedTrace(trace: ReviewTrace): SharedTrace | undefined {
  const flags = { redacted: false, truncated: false };
  const text = (value: string, max = MAX_TRACE_TEXT): string => {
    const r = redactField(value, max);
    flags.redacted ||= r.redacted;
    flags.truncated ||= r.truncated;
    return r.text;
  };
  const bounded = <T>(list: readonly T[], max: number): T[] => {
    if (list.length > max) flags.truncated = true;
    return list.slice(0, max);
  };
  const paths = (list: readonly string[]) =>
    bounded(list, MAX_TRACE_PATHS).map((p) => text(p, 1024));

  const shared: SharedTrace = {
    startedAt: trace.startedAt,
    ms: Math.round(trace.ms),
    stages: trace.stages.map((s) => ({
      ...s,
      startMs: Math.round(s.startMs),
      ms: Math.round(s.ms),
    })),
    tasks: bounded(trace.tasks, MAX_TRACE_TASKS).map((t) => task(t, text, paths, bounded)),
    calls: bounded(trace.calls, MAX_TRACE_CALLS).map((c) => ({
      ...c,
      startMs: Math.round(c.startMs),
      ms: Math.round(c.ms),
    })),
    findings: bounded(trace.findings, MAX_TRACE_FINDINGS).map((f) => finding(f, text)),
  };
  if (flags.redacted) shared.redacted = true;
  if (flags.truncated) shared.truncated = true;
  const fitted = [shared, withoutReads(shared)].find(fits);
  return fitted && sharedTraceSchema.safeParse(fitted).success ? fitted : undefined;
}

function task(
  t: TraceTask,
  text: (value: string) => string,
  paths: (list: readonly string[]) => string[],
  bounded: <T>(list: readonly T[], max: number) => T[],
): SharedTrace["tasks"][number] {
  return {
    id: t.id,
    reviewer: t.reviewer,
    bundle: text(t.bundle),
    files: paths(t.files),
    status: t.status,
    ...(t.startMs === undefined ? {} : { startMs: Math.round(t.startMs) }),
    ...(t.ms === undefined ? {} : { ms: Math.round(t.ms) }),
    ...(t.reusedFrom ? { reused: true as const } : {}),
    usage: t.usage,
    attempts: bounded(t.attempts, MAX_TRACE_ATTEMPTS).map((a) => ({
      ...a,
      startMs: Math.round(a.startMs),
      ms: Math.round(a.ms),
      read: paths(a.read),
    })),
  };
}

function finding(
  f: TraceFinding,
  text: (value: string) => string,
): SharedTrace["findings"][number] {
  return {
    ...f,
    file: text(f.file),
    title: text(f.title),
    ...(f.atMs === undefined ? {} : { atMs: Math.round(f.atMs) }),
    ...(f.reason === undefined ? {} : { reason: text(f.reason) }),
    ...(f.recalibrated
      ? { recalibrated: { ...f.recalibrated, reason: text(f.recalibrated.reason) } }
      : {}),
  };
}

function withoutReads(trace: SharedTrace): SharedTrace {
  return {
    ...trace,
    tasks: trace.tasks.map((t) => ({
      ...t,
      attempts: t.attempts.map((a) => ({ ...a, read: [] })),
    })),
    truncated: true,
  };
}

function fits(trace: SharedTrace): boolean {
  return Buffer.byteLength(JSON.stringify(trace)) <= MAX_TRACE_BYTES;
}
