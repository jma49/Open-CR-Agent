// The GitHub workflows ocra init writes: the manual's recipes (GitHub pull
// requests), with the key of the chosen provider and without OpenCode,
// since ocra init sets the direct runtime.

// The Action as the manual pins it: the release's commit and its version.
// `node scripts/changelog.mjs action-pin <version>` moves this line with the
// manual's; scripts/lib/manual-pins.test.mjs fails when they differ.
export const ACTION_USES = "jma49/Open-CR-Agent@82a3f1183a3177e9efa401d87eb95dea495ef619 # v0.6.0";

// By commit like the Action, so a moved tag cannot change what runs with the
// workflow's secrets; scripts/lib/manual-pins.test.mjs keeps every recipe pinned.
const CHECKOUT_USES = "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1";

export const REVIEW_LABEL = "ocra-review";

export type WorkflowKind = "fork-safe" | "same-repo";

export interface WorkflowOptions {
  kind: WorkflowKind;
  keyEnv: string;
  // False keeps OpenCode in the install, for a configuration that needs it.
  direct: boolean;
}

export function workflowFor({ kind, keyEnv, direct }: WorkflowOptions): string {
  const header = [
    "# Written by ocra init. What it does and how to change it:",
    "# https://github.com/jma49/Open-CR-Agent/blob/main/docs/manual/en/github.mdx",
  ];
  const action = [
    `uses: ${ACTION_USES}`,
    "with:",
    ...(direct ? ["  opencode: false"] : []),
    "  args: --max-cost-usd 2",
    "env:",
    `  ${keyEnv}: ${expr(`secrets.${keyEnv}`)}`,
  ];
  return `${[...header, ...(kind === "fork-safe" ? forkSafe(action) : sameRepo(action))].join("\n")}\n`;
}

// A GitHub Actions expression, ${{ ... }}.
function expr(expression: string): string {
  return `\${{ ${expression} }}`;
}

function step(lines: readonly string[], indent: string): string[] {
  const [first, ...rest] = lines;
  return [`${indent}- ${first}`, ...rest.map((line) => `${indent}  ${line}`)];
}

const ONE_REVIEW = "    # One review per pull request at a time: a new push cancels the older run.";

// The fork-safe job's condition, in its if: and in its concurrency group.
const GATE = [
  `(github.event.action == 'labeled' && github.event.label.name == '${REVIEW_LABEL}') ||`,
  "(github.event.action != 'labeled' &&",
  `  contains(fromJSON('["OWNER", "MEMBER", "COLLABORATOR"]'), github.event.pull_request.author_association))`,
];

function parenthesized(lines: readonly string[]): string[] {
  return lines.map(
    (line, i) => `${i === 0 ? "(" : " "}${line}${i === lines.length - 1 ? ")" : ""}`,
  );
}

function sameRepo(action: readonly string[]): string[] {
  return [
    "name: ocra",
    "on: pull_request",
    "",
    "permissions:",
    "  contents: read",
    "  pull-requests: write",
    "",
    "jobs:",
    "  review:",
    "    # A pull request from a fork gets no secrets on pull_request: skip it.",
    "    if: github.event.pull_request.head.repo.full_name == github.repository",
    ONE_REVIEW,
    "    concurrency:",
    `      group: ocra-${expr("github.event.pull_request.number")}`,
    "      cancel-in-progress: true",
    "    runs-on: ubuntu-latest",
    "    steps:",
    `      - uses: ${CHECKOUT_USES}`,
    "        with:",
    "          fetch-depth: 0",
    ...step(action, "      "),
  ];
}

function forkSafe(action: readonly string[]): string[] {
  return [
    "name: ocra",
    "on:",
    "  pull_request_target:",
    "    types: [opened, synchronize, reopened, labeled]",
    "",
    "permissions:",
    "  contents: read",
    "  pull-requests: write",
    "",
    "jobs:",
    "  review:",
    "    # Members and collaborators: every push. Anyone else: one review each",
    `    # time a maintainer adds the ${REVIEW_LABEL} label.`,
    "    if: >-",
    ...GATE.map((line) => `      ${line}`),
    ONE_REVIEW,
    "    # The key repeats the if:, so a run the if: skips gets a group of its",
    "    # own and cannot cancel the review in progress.",
    "    concurrency:",
    "      group: >-",
    `        ocra-${expr("github.event.pull_request.number")}-\${{`,
    ...parenthesized(GATE).map((line) => `          ${line}`),
    "          && 'review' || github.run_id }}",
    "      cancel-in-progress: true",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      # The base branch. Nothing from the pull request is checked out.",
    `      - uses: ${CHECKOUT_USES}`,
    "        with:",
    "          fetch-depth: 0",
    "          # In a private repository, remove this line: ocra fetches the",
    "          # pull request's commits with the checkout's credentials.",
    "          persist-credentials: false",
    ...step(action, "      "),
  ];
}
