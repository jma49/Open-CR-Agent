import { actionStep, CHECKOUT_USES, expr, HEADER, step, type WorkflowOptions } from "./workflow.js";

// The workflow ocra init writes next to the review's for comments that ask
// ocra something: `@ocra review` reviews the pull request again, and any
// other `@ocra` mention is answered in its thread (commands such as
// `@ocra override` are read by the next review, and ocra answers none).

const WRITER =
  'contains(fromJSON(\'["OWNER", "MEMBER", "COLLABORATOR"]\'), github.event.comment.author_association)';

// The review job's condition, in its if: and in its concurrency group.
// `/ocra review` is the earlier spelling, still taken.
const ASKS_FOR_REVIEW = [
  "github.event_name == 'issue_comment' && github.event.issue.pull_request &&",
  "(startsWith(github.event.comment.body, '@ocra review') ||",
  " startsWith(github.event.comment.body, '/ocra review')) &&",
  WRITER,
];

const MENTIONS = [
  "(github.event_name == 'pull_request_review_comment' || github.event.issue.pull_request) &&",
  "contains(github.event.comment.body, '@ocra') &&",
  "!startsWith(github.event.comment.body, '@ocra review') &&",
  WRITER,
];

// The review on push's concurrency group, so the two never run at once: the
// fork-safe workflow's is ocra-<number>-review, the pull_request one's
// ocra-<number>.
const GROUP: Record<WorkflowOptions["kind"], string> = {
  "fork-safe": "ocra-{0}-review",
  "same-repo": "ocra-{0}",
};

export function commandsWorkflowFor(options: WorkflowOptions): string {
  const checkout = (privateNote: boolean) => [
    "      # The base branch. Nothing from the pull request is checked out.",
    `      - uses: ${CHECKOUT_USES}`,
    "        with:",
    "          fetch-depth: 0",
    ...(privateNote
      ? [
          "          # In a private repository, remove this line: ocra fetches the",
          "          # pull request's commits with the checkout's credentials.",
        ]
      : []),
    "          persist-credentials: false",
  ];
  const lines = [
    ...HEADER,
    "name: ocra commands",
    "on:",
    "  issue_comment:",
    "    types: [created]",
    "  pull_request_review_comment:",
    "    types: [created]",
    "",
    "permissions:",
    "  checks: write",
    "  contents: read",
    "  issues: read",
    "  pull-requests: write",
    "",
    "jobs:",
    "  review:",
    "    # @ocra review on a pull request, by someone who can write: every file",
    "    # again, as with --full.",
    "    if: >-",
    ...ASKS_FOR_REVIEW.map((line) => `      ${line}`),
    "    # The key repeats the if:, so any other comment gets a group of its own",
    "    # and cannot cancel the review in progress.",
    "    concurrency:",
    "      group: >-",
    "        ${{",
    ...ASKS_FOR_REVIEW.map((line, i) => `          ${i === 0 ? "(" : " "}${line}`),
    `          ) && format('${GROUP[options.kind]}', github.event.issue.number) || github.run_id }}`,
    "      cancel-in-progress: true",
    "    runs-on: ubuntu-latest",
    "    steps:",
    ...checkout(true),
    ...step(actionStep(options, ["args: --max-cost-usd 2"]), "      "),
    "  reply:",
    "    # Any other @ocra mention by someone who can write, answered in its",
    "    # thread. ocra checks both again and answers each comment once.",
    "    if: >-",
    ...MENTIONS.map((line) => `      ${line}`),
    "    concurrency:",
    `      group: ocra-reply-${expr("github.event.comment.id")}`,
    "    runs-on: ubuntu-latest",
    "    steps:",
    ...checkout(false),
    ...step(actionStep(options, ["reply: true"]), "      "),
  ];
  return `${lines.join("\n")}\n`;
}
