import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { capture, deps, removeRepos, repoWithChange, type Script } from "../../run.fakes.js";
import { run } from "../../run.js";

afterEach(removeRepos);

const clean: Script = async function* (spec) {
  yield { type: "done", taskId: spec.taskId };
};

describe("ocra review --config", () => {
  it("reads the named file instead of the repository's, with --no-repo-config too", async () => {
    const cwd = repoWithChange();
    mkdirSync(join(cwd, ".ocra"));
    // The repository's file would exclude ci/**; the user's own file wins.
    writeFileSync(join(cwd, ".ocra", "config.json"), JSON.stringify({ exclude: ["ci/**"] }));
    mkdirSync(join(cwd, "ci"));
    writeFileSync(join(cwd, "ci", "ocra.json"), JSON.stringify({ exclude: ["app.ts"] }));

    for (const extra of [[], ["--no-repo-config"]]) {
      const out = capture();
      expect(
        await run(
          ["review", "--config", "ci/ocra.json", "--format", "json", ...extra],
          out,
          capture(),
          deps(cwd, clean),
        ),
      ).toBe(0);
      const report = JSON.parse(out.text());
      expect(report.coverage).toContainEqual({
        path: "app.ts",
        status: "excluded",
        reason: "user_exclude",
      });
      expect(report.coverage).toContainEqual({ path: "ci/ocra.json", status: "reviewed" });
    }
  });

  it("stops with exit 2 when the file cannot be read or is invalid", async () => {
    const cwd = repoWithChange();
    const err = capture();
    expect(await run(["review", "--config", "nope.json"], capture(), err, deps(cwd, clean))).toBe(
      2,
    );
    expect(err.text()).toContain("cannot read");
    writeFileSync(join(cwd, "bad.json"), "{");
    const invalid = capture();
    expect(
      await run(["review", "--config", "bad.json"], capture(), invalid, deps(cwd, clean)),
    ).toBe(2);
    expect(invalid.text()).toContain("bad.json is not valid JSON");
  });
});
