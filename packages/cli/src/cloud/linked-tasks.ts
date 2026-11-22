import {
  MAX_LINKED_TASKS,
  redactField,
  type SharedLinkedTask,
} from "@open-cr-agent/cloud-contract";
import type { LinkedTaskUse } from "@open-cr-agent/core";

// Which tasks a pull or merge request is linked to is part of its identity
// (ADR-0038); what they say goes only with the findings (ADR-0028).
export function sharedLinkedTasks(
  tasks: readonly LinkedTaskUse[],
  withContent: boolean,
): SharedLinkedTask[] {
  return tasks.slice(0, MAX_LINKED_TASKS).map((task) => ({
    tracker: task.tracker,
    key: task.key,
    ...(task.url ? { url: task.url } : {}),
    state: task.state ?? null,
    ...(withContent
      ? {
          title: redactField(task.title).text,
          labels: task.labels.slice(0, 10).map((l) => redactField(l, 256).text),
        }
      : {}),
  }));
}
