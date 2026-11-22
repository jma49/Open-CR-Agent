// A task in the team's tracker that the change was written for (ADR-0052),
// as a platform adapter converted it from its tracker's API.
export interface LinkedTask {
  tracker: TaskTracker;
  // As the tracker writes it: "#12" on GitHub and GitLab, "PAY-12" on Jira,
  // "story-1001234" on TAPD.
  key: string;
  url?: string;
  title: string;
  state?: TaskState;
  labels: readonly string[];
  body: string;
  parent?: { key: string; title: string; body: string };
  subtasks: readonly { key: string; title: string; state?: TaskState }[];
}

export const TASK_TRACKERS = ["github", "gitlab", "jira", "tapd"] as const;
export type TaskTracker = (typeof TASK_TRACKERS)[number];
export type TaskState = "open" | "closed";

// A tracker the platform does not link: its keys are found in the change
// request's title, description and branch, and its tasks fetched by key.
export interface TaskSource {
  readonly tracker: TaskTracker;
  // The keys of this tracker's tasks the text names, in order, normalized.
  keysIn(text: string): string[];
  // Undefined when the tracker has no such task.
  fetch(key: string, signal: AbortSignal): Promise<LinkedTask | undefined>;
}

// A linked task the review tasks were given, for the report.
export interface LinkedTaskUse {
  tracker: TaskTracker;
  key: string;
  url?: string;
  title: string;
  state?: TaskState;
  labels: string[];
  // Its body, its parent's or its list of subtasks was cut to the limits.
  cut: boolean;
}

export const LINKED_TASK_LIMITS = {
  tasks: 3,
  body: 4_000,
  parentBody: 1_500,
  subtasks: 10,
  labels: 10,
} as const;

export interface BoundLinkedTasks {
  given: LinkedTask[];
  uses: LinkedTaskUse[];
}

// The first tasks, in the platform's order, each held to the limits. Bodies
// are cut where they are rendered, which marks the cut in the prompt.
export function boundLinkedTasks(tasks: readonly LinkedTask[]): BoundLinkedTasks {
  const given = tasks.slice(0, LINKED_TASK_LIMITS.tasks);
  return {
    given: given.map((task) => ({
      ...task,
      labels: task.labels.slice(0, LINKED_TASK_LIMITS.labels),
      subtasks: task.subtasks.slice(0, LINKED_TASK_LIMITS.subtasks),
    })),
    uses: given.map(taskUse),
  };
}

function taskUse(task: LinkedTask): LinkedTaskUse {
  return {
    tracker: task.tracker,
    key: task.key,
    ...(task.url ? { url: task.url } : {}),
    title: task.title,
    ...(task.state ? { state: task.state } : {}),
    labels: task.labels.slice(0, LINKED_TASK_LIMITS.labels),
    cut:
      task.body.length > LINKED_TASK_LIMITS.body ||
      (task.parent?.body.length ?? 0) > LINKED_TASK_LIMITS.parentBody ||
      task.subtasks.length > LINKED_TASK_LIMITS.subtasks ||
      task.labels.length > LINKED_TASK_LIMITS.labels,
  };
}
