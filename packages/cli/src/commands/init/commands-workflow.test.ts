import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { commandsWorkflowFor } from "./commands-workflow.js";
import { HEADER } from "./workflow.js";

const manual = readFileSync(
  new URL("../../../../../docs/manual/en/github.mdx", import.meta.url),
  "utf8",
);

function recipe(heading: string): string {
  const section = manual.slice(manual.indexOf(`\n${heading}\n`));
  const block = /```yaml\n([\s\S]*?)```/.exec(section)?.[1];
  if (!block) throw new Error(`no YAML block under ${heading}`);
  return block;
}

function withoutHeader(workflow: string): string {
  return workflow.split("\n").slice(HEADER.length).join("\n");
}

describe("commandsWorkflowFor", () => {
  it("is the manual's comment workflow", () => {
    const workflow = commandsWorkflowFor({
      kind: "fork-safe",
      keyEnv: "GEMINI_API_KEY",
      direct: false,
    });
    expect(workflow.startsWith(`${HEADER.join("\n")}\n`)).toBe(true);
    expect(withoutHeader(workflow)).toBe(recipe("### The comment workflow"));
    expect(workflow).not.toMatch(/ref:|head\.sha|npm |run:/);
  });

  it("reviews on @ocra review or the earlier /ocra review, and answers any other mention", () => {
    const workflow = commandsWorkflowFor({ kind: "fork-safe", keyEnv: "K", direct: false });
    expect(workflow).toContain("startsWith(github.event.comment.body, '@ocra review')");
    expect(workflow).toContain("startsWith(github.event.comment.body, '/ocra review')");
    expect(workflow).toContain("!startsWith(github.event.comment.body, '@ocra review')");
    expect(workflow).toContain("          reply: true\n");
  });

  it.each([
    ["fork-safe", "format('ocra-{0}-review', github.event.issue.number)"],
    ["same-repo", "format('ocra-{0}', github.event.issue.number)"],
  ] as const)("%s: shares the review on push's concurrency group", (kind, group) => {
    const workflow = commandsWorkflowFor({ kind, keyEnv: "K", direct: false });
    expect(workflow).toContain(`) && ${group} || github.run_id }}`);
  });

  it("passes the provider's key to both jobs, and leaves OpenCode out on the direct runtime", () => {
    const direct = commandsWorkflowFor({
      kind: "fork-safe",
      keyEnv: "OPENROUTER_API_KEY",
      direct: true,
    });
    expect(direct.match(/opencode: false/g)).toHaveLength(2);
    expect(
      direct.match(/OPENROUTER_API_KEY: \$\{\{ secrets\.OPENROUTER_API_KEY \}\}/g),
    ).toHaveLength(2);
  });

  // CI's workflows job runs actionlint on these files.
  it.each([
    ["fork-safe", "fork-safe"],
    ["same-repo", "same-repo"],
  ] as const)("%s matches its file for actionlint", async (kind, file) => {
    await expect(
      commandsWorkflowFor({ kind, keyEnv: "GEMINI_API_KEY", direct: false }),
    ).toMatchFileSnapshot(`./__snapshots__/ocra-commands-${file}.yml`);
  });
});
