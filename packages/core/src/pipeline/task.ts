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
  defaultCategory: string;
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
  try {
    iterator = runtime.runTask(spec, signal)[Symbol.asyncIterator]();
    for (;;) {
      const next = await untilAborted(iterator.next(), signal);
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
      void iterator?.return?.();
    } else {
      result.status = "failed";
      result.error = errorMessage(error);
    }
  }
  return result;
}

function handle(event: AgentEvent, result: TaskResult, callbacks: TaskCallbacks): boolean {
  switch (event.type) {
    case "progress":
      callbacks.onProgress(event.message);
      return false;
    case "finding": {
      const parsed = reportedFindingSchema.safeParse(
        withDefaultCategory(event.finding, callbacks.defaultCategory),
      );
      if (parsed.success) result.findings.push(parsed.data);
      else result.warnings.push("runtime reported a finding that failed validation");
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

function withDefaultCategory(finding: unknown, category: string): unknown {
  if (typeof finding !== "object" || finding === null) return finding;
  return { category, ...finding };
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
