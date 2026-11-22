import { errorMessage } from "../errors.js";
import { type BoundLinkedTasks, boundLinkedTasks } from "../task/linked-task.js";
import type { VcsAdapter } from "../vcs.js";

export interface LoadedLinkedTasks {
  // Absent when the switch is off, the adapter cannot link tasks, or the
  // lookup failed.
  tasks?: BoundLinkedTasks;
  warning?: string;
}

// A failed lookup costs the task context, not the review (ADR-0052).
export async function loadLinkedTasks(
  vcs: VcsAdapter,
  enabled: boolean,
): Promise<LoadedLinkedTasks> {
  if (!enabled || !vcs.linkedTasks) return {};
  try {
    return { tasks: boundLinkedTasks(await vcs.linkedTasks()) };
  } catch (error) {
    return { warning: `the linked tasks could not be read: ${errorMessage(error)}` };
  }
}
