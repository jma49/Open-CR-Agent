// The GitHub workflows ocra init writes: the manual's recipes (GitHub pull
// requests), with the key of the chosen provider and without OpenCode,
// since ocra init sets the direct runtime.

// The Action as the manual pins it: the release's commit and its version.
// `node scripts/changelog.mjs action-pin <version>` moves this line with the
// manual's; scripts/lib/manual-pins.test.mjs fails when they differ.
export const ACTION_USES = "jma49/Open-CR-Agent@82a3f1183a3177e9efa401d87eb95dea495ef619 # v0.6.0";

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

function sameRepo(action: readonly string[]): string[] {
  return [
    "name: ocra",
    "on: pull_request",
    "",
    "permissions:",
    "  contents: read",
    "  pull-requests: write",
    "",
    "# One review per pull request at a time: a new push cancels the older run.",
    "concurrency:",
    `  group: ocra-${expr("github.event.pull_request.number")}`,
    "  cancel-in-progress: true",
    "",
    "jobs:",
    "  review:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - uses: actions/checkout@v7",
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
    "concurrency:",
    `  group: ocra-${expr("github.event.pull_request.number")}`,
    "  cancel-in-progress: true",
    "",
    "jobs:",
    "  review:",
    "    # Members and collaborators: every push. Anyone else: one review each",
    `    # time a maintainer adds the ${REVIEW_LABEL} label.`,
    "    if: >-",
    `      (github.event.action == 'labeled' && github.event.label.name == '${REVIEW_LABEL}') ||`,
    "      (github.event.action != 'labeled' &&",
    `        contains(fromJSON('["OWNER", "MEMBER", "COLLABORATOR"]'), github.event.pull_request.author_association))`,
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      # The base branch. Nothing from the pull request is checked out.",
    "      - uses: actions/checkout@v7",
    "        with:",
    "          fetch-depth: 0",
    "          # In a private repository, remove this line: ocra fetches the",
    "          # pull request's commits with the checkout's credentials.",
    "          persist-credentials: false",
    ...step(action, "      "),
  ];
}
