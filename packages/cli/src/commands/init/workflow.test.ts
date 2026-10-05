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
// where the recipe has none, OpenCode left out, and a note on private
// repositories.
const ADDED: Record<WorkflowKind, string[]> = {
  "fork-safe": [
    "# Written by ocra init. What it does and how to change it:",
    "# https://github.com/jma49/Open-CR-Agent/blob/main/docs/manual/en/github.mdx",
    "          # In a private repository, remove this line: ocra fetches the",
    "          # pull request's commits with the checkout's credentials.",
    "          opencode: false",
  ],
  "same-repo": [
    "# Written by ocra init. What it does and how to change it:",
    "# https://github.com/jma49/Open-CR-Agent/blob/main/docs/manual/en/github.mdx",
    "        with:",
    "          opencode: false",
    "          args: --max-cost-usd 2",
  ],
};

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
    const workflow = workflowFor({ kind: "fork-safe", keyEnv: "GEMINI_API_KEY", direct: true });
    expect(without(workflow, ADDED["fork-safe"])).toBe(recipe("## Pull requests from forks"));
    expect(workflow).toContain("args: --max-cost-usd 2");
    expect(workflow).not.toMatch(/ref:|head\.sha|npm |run:/);
  });

  it("with --same-repo-only, is the manual's pull_request workflow with a spend limit", () => {
    const workflow = workflowFor({ kind: "same-repo", keyEnv: "GEMINI_API_KEY", direct: true });
    expect(without(workflow, ADDED["same-repo"])).toBe(recipe("## GitHub Action"));
    expect(workflow).not.toContain("pull_request_target");
  });

  it("pins the Action as the manual does", () => {
    for (const kind of ["fork-safe", "same-repo"] as const) {
      const workflow = workflowFor({ kind, keyEnv: "GEMINI_API_KEY", direct: true });
      expect(workflow).toContain(`      - uses: ${ACTION_USES}\n`);
    }
    expect(ACTION_USES).toMatch(/^jma49\/Open-CR-Agent@[0-9a-f]{40} # v\d+\.\d+\.\d+$/);
  });

  it("passes the chosen provider's key, and keeps OpenCode for a configuration that needs it", () => {
    const workflow = workflowFor({
      kind: "fork-safe",
      keyEnv: "OPENROUTER_API_KEY",
      direct: false,
    });
    expect(workflow).toContain(
      `        env:\n          OPENROUTER_API_KEY: \${{ secrets.OPENROUTER_API_KEY }}\n`,
    );
    expect(workflow).not.toContain("GEMINI");
    expect(workflow).not.toContain("opencode:");
  });

  // CI's workflows job runs actionlint on these files.
  it.each(["fork-safe", "same-repo"] as const)(
    "%s matches its file for actionlint",
    async (kind) => {
      await expect(
        workflowFor({ kind, keyEnv: "GEMINI_API_KEY", direct: true }),
      ).toMatchFileSnapshot(`./__snapshots__/ocra-${kind}.yml`);
    },
  );
});
