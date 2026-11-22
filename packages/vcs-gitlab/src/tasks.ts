import type { LinkedTask } from "@open-cr-agent/core";
import type { GitLabApi, Issue } from "./client.js";

// GitLab names a branch made from an issue "<iid>-<title>".
const ISSUE_BRANCH = /^(\d+)-/;

// The issues of this project the merge request closes, or the one its source
// branch is named after (ADR-0052). Another project's issue is left out: a
// fork's author could otherwise pull text they cannot read into a review
// posted where they can.
export async function gitlabLinkedTasks(api: GitLabApi, iid: number): Promise<LinkedTask[]> {
  const [mr, closing] = await Promise.all([api.getMergeRequest(iid), api.closesIssues(iid)]);
  const own = closing.filter((issue) => issue.project_id === mr.target_project_id);
  if (own.length > 0) return own.map(linkedTask);
  const branched = ISSUE_BRANCH.exec(mr.source_branch)?.[1];
  if (!branched) return [];
  const issue = await api.getIssue(Number(branched));
  return issue ? [linkedTask(issue)] : [];
}

function linkedTask(issue: Issue): LinkedTask {
  return {
    tracker: "gitlab",
    key: `#${issue.iid}`,
    url: issue.web_url,
    title: issue.title,
    state: issue.state === "opened" ? "open" : "closed",
    labels: issue.labels,
    body: issue.description,
    // The issue names its epic, not the epic's description.
    ...(issue.epic
      ? { parent: { key: `&${issue.epic.iid}`, title: issue.epic.title, body: "" } }
      : {}),
    subtasks: [],
  };
}
