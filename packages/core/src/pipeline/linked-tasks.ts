import type { ChangeRequest } from "../domain.js";
import { errorMessage } from "../errors.js";
import {
  type BoundLinkedTasks,
  boundLinkedTasks,
  LINKED_TASK_LIMITS,
  type LinkedTask,
  type TaskSource,
} from "../task/linked-task.js";
import type { VcsAdapter } from "../vcs.js";

export interface LoadedLinkedTasks {
  // Absent when the switch is off, or nothing could be looked up.
  tasks?: BoundLinkedTasks;
  warnings: string[];
}

// The platform's links first, then the tasks other trackers' keys in the
// title, description and branch name, up to the limit. A failed lookup
// costs that task, not the review (ADR-0052).
export async function loadLinkedTasks(
  vcs: VcsAdapter,
  changeRequest: ChangeRequest,
  sources: readonly TaskSource[],
  { enabled, signal }: { enabled: boolean; signal: AbortSignal },
): Promise<LoadedLinkedTasks> {
  if (!enabled) return { warnings: [] };
  const warnings: string[] = [];
  let platform: LinkedTask[] | undefined;
  if (vcs.linkedTasks) {
    try {
      platform = await vcs.linkedTasks();
    } catch (error) {
      warnings.push(`the linked tasks could not be read: ${errorMessage(error)}`);
    }
  }
  if (platform === undefined && sources.length === 0) return { warnings };
  const tasks = [...(platform ?? [])];
  const text = [changeRequest.title, changeRequest.description, changeRequest.branch ?? ""];
  for (const { source, key } of namedKeys(sources, text)) {
    if (tasks.length >= LINKED_TASK_LIMITS.tasks) break;
    try {
      const task = await source.fetch(key, signal);
      if (task) tasks.push(task);
    } catch (error) {
      signal.throwIfAborted();
      warnings.push(`${source.tracker} task ${key} could not be read: ${errorMessage(error)}`);
    }
  }
  return { tasks: boundLinkedTasks(tasks), warnings };
}

function namedKeys(
  sources: readonly TaskSource[],
  text: readonly string[],
): { source: TaskSource; key: string }[] {
  return sources.flatMap((source) => {
    const keys = new Set(text.flatMap((t) => source.keysIn(t)));
    return [...keys].map((key) => ({ source, key }));
  });
}
