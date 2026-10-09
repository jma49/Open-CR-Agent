import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ACTION_USES, type WorkflowKind, workflowFor } from "./workflow.js";

const manual = readFileSync(
  new URL("../../../../../docs/manual/en/github.mdx", import.meta.url),
  "utf8",
);

// The first YAML block of the manual's section with that heading.
function recipe(heading: string): string {
  const section = manual.slice(manual.indexOf(`\n${heading}\n`));
  const block = /```yaml\n([\s\S]*?)```/.exec(section)?.[1];
  if (!block) throw new Error(`no YAML block under ${heading}`);
  return block;
}

// What ocra init adds to the manual's recipe: a header, the spend limit
// where the recipe has none, and a note on private repositories.
const ADDED: Record<WorkflowKind, string[]> = {
  "fork-safe": [
    "# Written by ocra init. What it does and how to change it:",
    "# https://github.com/jma49/Open-CR-Agent/blob/main/docs/manual/en/github.mdx",
    "          # In a private repository, remove this line: ocra fetches the",
    "          # pull request's commits with the checkout's credentials.",
  ],
  "same-repo": [
    "# Written by ocra init. What it does and how to change it:",
    "# https://github.com/jma49/Open-CR-Agent/blob/main/docs/manual/en/github.mdx",
    "        with:",
    "          args: --max-cost-usd 2",
  ],
};

function topLevelKeys(workflow: string): string[] {
  return workflow
    .split("\n")
    .filter((line) => /^[a-z]/.test(line))
    .map((line) => line.slice(0, line.indexOf(":")));
}

// The first value of that key, a folded block (>-) included, with each run of
// whitespace as one space, as GitHub reads an expression.
function keyValue(workflow: string, key: string): string {
  const lines = workflow.split("\n");
  const at = lines.findIndex((line) => line.trimStart().startsWith(`${key}: `));
  expect(at, key).toBeGreaterThanOrEqual(0);
  const line = lines[at] ?? "";
  const value = line.slice(line.indexOf(":") + 2);
  if (value !== ">-") return value;
  const indent = line.length - line.trimStart().length;
  const block = lines.slice(at + 1);
  const end = block.findIndex((l) => l.length - l.trimStart().length <= indent);
  return block
    .slice(0, end < 0 ? undefined : end)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

const PULL_REQUEST = `ocra-\${{ github.event.pull_request.number }}`;

function without(text: string, lines: readonly string[]): string {
  const rest = text.split("\n");
  for (const line of lines) {
    const at = rest.lastIndexOf(line);
    expect(at, line).toBeGreaterThanOrEqual(0);
    rest.splice(at, 1);
  }
  return rest.join("\n");
}

describe("workflowFor", () => {
  it("is the manual's fork recipe on pull_request_target, gated by the ocra-review label", () => {
    const workflow = workflowFor({ kind: "fork-safe", keyEnv: "GEMINI_API_KEY", direct: false });
    expect(without(workflow, ADDED["fork-safe"])).toBe(recipe("## Pull requests from forks"));
    expect(workflow).toContain("args: --max-cost-usd 2");
    expect(workflow).not.toMatch(/ref:|head\.sha|npm |run:/);
  });

  it("with --same-repo-only, is the manual's pull_request workflow with a spend limit", () => {
    const workflow = workflowFor({ kind: "same-repo", keyEnv: "GEMINI_API_KEY", direct: false });
    expect(without(workflow, ADDED["same-repo"])).toBe(recipe("## GitHub Action"));
    expect(workflow).not.toContain("pull_request_target");
  });

  it.each(["fork-safe", "same-repo"] as const)(
    "%s: one review per pull request at a time, from the review job",
    (kind) => {
      const workflow = workflowFor({ kind, keyEnv: "GEMINI_API_KEY", direct: false });
      expect(topLevelKeys(workflow)).toEqual(["name", "on", "permissions", "jobs"]);
      expect(workflow).toContain("\n    concurrency:\n      group: ");
      expect(keyValue(workflow, "group").startsWith(PULL_REQUEST)).toBe(true);
      expect(keyValue(workflow, "cancel-in-progress")).toBe("true");
    },
  );

  // An unrelated label, or an outside author's push during a labelled
  // review, starts a run the if: skips; in the review's group it would
  // cancel the review.
  it("gives a run its if: skips a concurrency group of its own", () => {
    const workflow = workflowFor({ kind: "fork-safe", keyEnv: "GEMINI_API_KEY", direct: false });
    const condition = keyValue(workflow, "if");
    expect(condition).toContain("github.event.label.name == 'ocra-review'");
    expect(keyValue(workflow, "group")).toBe(
      `${PULL_REQUEST}-\${{ (${condition}) && 'review' || github.run_id }}`,
    );
  });

  it("with --same-repo-only, skips pull requests from forks, which get no secrets", () => {
    const workflow = workflowFor({ kind: "same-repo", keyEnv: "GEMINI_API_KEY", direct: false });
    expect(workflow).toContain(
      "\n    if: github.event.pull_request.head.repo.full_name == github.repository\n",
    );
  });

  it("pins the Action as the manual does", () => {
    for (const kind of ["fork-safe", "same-repo"] as const) {
      const workflow = workflowFor({ kind, keyEnv: "GEMINI_API_KEY", direct: true });
      expect(workflow).toContain(`      - uses: ${ACTION_USES}\n`);
    }
    expect(ACTION_USES).toMatch(/^jma49\/Open-CR-Agent@[0-9a-f]{40} # v\d+\.\d+\.\d+$/);
  });

  it("passes the chosen provider's key, and leaves OpenCode out on the direct runtime", () => {
    const direct = workflowFor({ kind: "fork-safe", keyEnv: "OPENROUTER_API_KEY", direct: true });
    expect(direct).toContain(
      `        with:\n          opencode: false\n          args: --max-cost-usd 2\n        env:\n          OPENROUTER_API_KEY: \${{ secrets.OPENROUTER_API_KEY }}\n`,
    );
    expect(direct).not.toContain("GEMINI");
    const opencode = workflowFor({ kind: "fork-safe", keyEnv: "GEMINI_API_KEY", direct: false });
    expect(opencode).not.toContain("opencode:");
  });

  // CI's workflows job runs actionlint on these files.
  it.each([
    ["fork-safe", "GEMINI_API_KEY", false, "fork-safe"],
    ["same-repo", "GEMINI_API_KEY", false, "same-repo"],
    ["fork-safe", "OPENROUTER_API_KEY", true, "fork-safe-direct"],
  ] as const)("%s with %s matches its file for actionlint", async (kind, keyEnv, direct, file) => {
    await expect(workflowFor({ kind, keyEnv, direct })).toMatchFileSnapshot(
      `./__snapshots__/ocra-${file}.yml`,
    );
  });
});
