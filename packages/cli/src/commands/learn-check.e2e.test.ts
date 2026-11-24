import { scratchRepos } from "@open-cr-agent/test-support";
import { afterEach, describe, expect, it } from "vitest";
import { capture, deps } from "../run.fakes.js";
import { run } from "../run.js";

const repos = scratchRepos("ocra-learn-check-");
afterEach(() => repos.removeAll());

const learning = (title: string, paths: string[]) =>
  [
    "---",
    `title: ${title}`,
    "paths:",
    ...paths.map((p) => `  - "${p}"`),
    "created: 2026-11-01",
    "---",
    "",
    "Check it.",
    "",
  ].join("\n");

async function check(cwd: string) {
  const out = capture();
  const err = capture();
  const code = await run(
    ["learn", "check"],
    out,
    err,
    deps(cwd, async function* () {}),
  );
  return { code, out: out.text(), err: err.text() };
}

describe("ocra learn check", () => {
  it("names the learnings whose paths match no file at HEAD, with no model call", async () => {
    const repo = repos.create();
    repo.commit("feat: billing", {
      "services/billing/charge.ts": "export const charge = 1;\n",
      ".ocra/learnings/charge-twice.md": learning("Never charge twice", ["services/billing/"]),
      ".ocra/learnings/refund-cap.md": learning("Cap refunds", ["src/refunds/**", "*.ts"]),
    });
    const moved = await check(repo.dir);
    expect(moved.code).toBe(1);
    expect(moved.out).toBe("refund-cap: no file matches src/refunds/**\n");
    expect(moved.err).toContain("1 of 2 learning(s) name paths that match no file");

    repo.commit("refactor: refunds", { "src/refunds/cap.ts": "export const cap = 1;\n" });
    const fixed = await check(repo.dir);
    expect(fixed).toMatchObject({ code: 0, out: "" });
    expect(fixed.err).toContain("every path of the 2 learning(s) matches a file");
  });
});
