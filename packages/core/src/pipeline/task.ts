import type { AgentEvent, AgentRuntime, AgentTaskSpec, Usage } from "../contracts.js";
import { type ReportedFinding, reportedFindingSchema } from "../domain.js";
import { errorMessage } from "../errors.js";
import type { TaskStatus } from "./report.js";
import { addUsage, emptyUsage } from "./usage.js";

export interface TaskResult {
  status: TaskStatus;
  error?: string;
  findings: ReportedFinding[];
  usage: Usage;
  warnings: string[];
}

export interface TaskCallbacks {
  onProgress(message: string): void;
  category: string;
  abortGraceMs?: number | undefined;
}

export async function executeTask(
  runtime: AgentRuntime,
  spec: AgentTaskSpec,
  runSignal: AbortSignal,
  callbacks: TaskCallbacks,
): Promise<TaskResult> {
  const timeout = AbortSignal.timeout(spec.timeoutMs);
  const signal = AbortSignal.any([runSignal, timeout]);
  const result: TaskResult = {
    status: "completed",
    findings: [],
    usage: emptyUsage(),
    warnings: [],
  };

  let iterator: AsyncIterator<AgentEvent> | undefined;
  let pending: Promise<IteratorResult<AgentEvent>> | undefined;
  try {
    iterator = runtime.runTask(spec, signal)[Symbol.asyncIterator]();
    for (;;) {
      pending = iterator.next();
      const next = await untilAborted(pending, signal);
      pending = undefined;
      if (next.done) break;
      if (handle(next.value, result, callbacks)) {
        void iterator.return?.();
        break;
      }
    }
  } catch (error) {
    if (signal.aborted) {
      const timedOut = timeout.aborted && !runSignal.aborted;
      result.status = timedOut ? "timed_out" : "cancelled";
      result.error = timedOut ? `timed out after ${spec.timeoutMs}ms` : "run cancelled";
      if (iterator) await collectAfterAbort(iterator, pending, result, callbacks);
      void iterator?.return?.();
    } else {
      result.status = "failed";
      result.error = errorMessage(error);
    }
  }
  return result;
}

// A task cut off by its timeout or by Ctrl-C has still spent tokens and may
// have reported findings; a runtime that stops its session delivers them
// shortly after. Waiting a bounded moment keeps them in the report and in
// the spend limit, without letting a runtime that ignores the abort hang.
export const ABORT_GRACE_MS = 10_000;

async function collectAfterAbort(
  iterator: AsyncIterator<AgentEvent>,
  pending: Promise<IteratorResult<AgentEvent>> | undefined,
  result: TaskResult,
  callbacks: TaskCallbacks,
): Promise<void> {
  const grace = AbortSignal.timeout(callbacks.abortGraceMs ?? ABORT_GRACE_MS);
  let next = pending ?? iterator.next();
  try {
    for (;;) {
      const event = await untilAborted(next, grace);
      if (event.done) return;
      const { value } = event;
      if (value.type === "usage" || value.type === "finding") handle(value, result, callbacks);
      if (value.type === "done" || value.type === "error") return;
      next = iterator.next();
    }
  } catch {
    // The runtime did not finish within the grace period, or failed: keep
    // what arrived.
  }
}

function handle(event: AgentEvent, result: TaskResult, callbacks: TaskCallbacks): boolean {
  switch (event.type) {
    case "progress":
      callbacks.onProgress(event.message);
      return false;
    case "finding": {
      const parsed = reportedFindingSchema.safeParse(
        withReviewerCategory(event.finding, callbacks.category),
      );
      if (!parsed.success) {
        result.warnings.push("runtime reported a finding that failed validation");
      } else if (result.findings.length >= MAX_FINDINGS_PER_TASK) {
        const warning = `more than ${MAX_FINDINGS_PER_TASK} findings in one task; the rest were dropped`;
        if (!result.warnings.includes(warning)) result.warnings.push(warning);
      } else {
        result.findings.push(bounded(parsed.data));
      }
      return false;
    }
    case "usage":
      result.usage = addUsage(result.usage, event);
      return false;
    case "done":
      return true;
    case "error":
      result.status = "failed";
      result.error = event.error;
      return true;
  }
}

// A reviewer steered by the change could flood the pull request with
// comments or pad them without end; both are bounded.
export const MAX_FINDINGS_PER_TASK = 50;
const MAX_TITLE = 300;
const MAX_TEXT = 4_000;
const MAX_EVIDENCE = 10;

function bounded(f: ReportedFinding): ReportedFinding {
  const cut = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text);
  return {
    ...f,
    title: cut(f.title, MAX_TITLE),
    body: cut(f.body, MAX_TEXT),
    ...(f.suggestion !== undefined ? { suggestion: cut(f.suggestion, MAX_TEXT) } : {}),
    evidence: f.evidence.slice(0, MAX_EVIDENCE).map((e) => cut(e, 500)),
  };
}

// The category is part of the fingerprint, so it comes from the reviewer and
// never from the model: a model choosing another word would make the same
// issue look new, and its earlier report look fixed.
function withReviewerCategory(finding: unknown, category: string): unknown {
  if (typeof finding !== "object" || finding === null) return finding;
  return { ...finding, category };
}

// Runtimes may ignore the abort signal, so waiting for their next event is
// raced against it to keep the task and run timeouts authoritative.
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}
