import { LINKED_TASK_LIMITS, type LinkedTask, OcraError } from "@open-cr-agent/core";
import { z } from "zod";
import type { GitHubApi } from "./client.js";

interface Repository {
  owner: string;
  repo: string;
  number: number;
}

// One past each limit, so the report can tell that a list was cut.
const ISSUE_FIELDS = `number title body state url repository { nameWithOwner }
  labels(first: ${LINKED_TASK_LIMITS.labels + 1}) { nodes { name } }
  parent { number title body }
  subIssues(first: ${LINKED_TASK_LIMITS.subtasks + 1}) { nodes { number title state } }`;

const CLOSING_QUERY = `query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      headRefName
      closingIssuesReferences(first: 10) { nodes { ${ISSUE_FIELDS} } }
    }
  }
}`;

// A branch may be named after a pull request's number too; only an issue counts.
const ISSUE_QUERY = `query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    issueOrPullRequest(number: $number) { ... on Issue { ${ISSUE_FIELDS} } }
  }
}`;

const state = z.enum(["OPEN", "CLOSED"]).transform((s) => (s === "OPEN" ? "open" : "closed"));
const body = z
  .string()
  .nullable()
  .transform((b) => b ?? "");

const issueSchema = z.object({
  number: z.number(),
  title: z.string(),
  body,
  state,
  url: z.string(),
  repository: z.object({ nameWithOwner: z.string() }),
  labels: z.object({ nodes: z.array(z.object({ name: z.string() })) }),
  parent: z.object({ number: z.number(), title: z.string(), body }).nullable(),
  subIssues: z.object({
    nodes: z.array(z.object({ number: z.number(), title: z.string(), state })),
  }),
});
type Issue = z.infer<typeof issueSchema>;

const closingSchema = z.object({
  repository: z.object({
    pullRequest: z.object({
      headRefName: z.string(),
      closingIssuesReferences: z.object({ nodes: z.array(issueSchema) }),
    }),
  }),
});

const issueOrPullRequestSchema = z.object({
  repository: z.object({
    // A pull request matches no field of the fragment: an empty object.
    issueOrPullRequest: z.record(z.string(), z.unknown()).nullable(),
  }),
});

// GitHub names a branch made from an issue "<number>-<title>".
const ISSUE_BRANCH = /^(\d+)-/;

// The issues of this repository the pull request closes, or the one its
// branch is named after (ADR-0051). Another repository's issue is left out:
// a fork's author could otherwise pull text they cannot read into a review
// posted where they can.
export async function githubLinkedTasks(api: GitHubApi, pr: Repository): Promise<LinkedTask[]> {
  const variables = { owner: pr.owner, repo: pr.repo, number: pr.number };
  const { pullRequest } = answer(
    closingSchema,
    await api.graphql(CLOSING_QUERY, variables),
  ).repository;
  const own = (issue: Issue) =>
    issue.repository.nameWithOwner.toLowerCase() === `${pr.owner}/${pr.repo}`.toLowerCase();
  const closing = pullRequest.closingIssuesReferences.nodes.filter(own);
  if (closing.length > 0) return closing.map(linkedTask);
  const branched = ISSUE_BRANCH.exec(pullRequest.headRefName)?.[1];
  if (!branched) return [];
  const node = answer(
    issueOrPullRequestSchema,
    await api.graphql(ISSUE_QUERY, { ...variables, number: Number(branched) }),
  ).repository.issueOrPullRequest;
  if (!node || !("number" in node)) return [];
  return [linkedTask(answer(issueSchema, node))];
}

function answer<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  throw new OcraError(
    "VCS_API_FAILED",
    "GitHub's answer about the linked issues has an unexpected shape",
  );
}

function linkedTask(issue: Issue): LinkedTask {
  return {
    tracker: "github",
    key: `#${issue.number}`,
    url: issue.url,
    title: issue.title,
    state: issue.state,
    labels: issue.labels.nodes.map((l) => l.name),
    body: issue.body,
    ...(issue.parent
      ? {
          parent: {
            key: `#${issue.parent.number}`,
            title: issue.parent.title,
            body: issue.parent.body,
          },
        }
      : {}),
    subtasks: issue.subIssues.nodes.map((s) => ({
      key: `#${s.number}`,
      title: s.title,
      state: s.state,
    })),
  };
}
