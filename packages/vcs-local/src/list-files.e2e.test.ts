import { scratchRepos } from "@open-cr-agent/test-support";
import { afterEach, describe, expect, it } from "vitest";
import { LocalGitAdapter } from "./local-adapter.js";

const scratch = scratchRepos("ocra-list-files-");
afterEach(() => scratch.removeAll());

describe("LocalGitAdapter.listFiles", () => {
  it("lists the files directly in a directory of a commit, not those below it", async () => {
    const r = scratch.create();
    const first = r.commit("first", {
      "notes/a.md": "a\n",
      "notes/b.md": "b\n",
      "notes/deep/c.md": "c\n",
      "other/d.md": "d\n",
    });
    r.commit("second", { "notes/later.md": "later\n" });
    const adapter = new LocalGitAdapter({ cwd: r.dir, target: { mode: "commit", commit: first } });
    expect(await adapter.listFiles("notes")).toEqual(["notes/a.md", "notes/b.md"]);
    expect(await adapter.readFile("notes/a.md")).toBe("a\n");
  });

  it("lists tracked and untracked files of the workspace, leaving out ignored ones", async () => {
    const r = scratch.create();
    r.commit("first", { "notes/a.md": "a\n", ".gitignore": "notes/ignored.md\n" });
    r.write("notes/new.md", "new\n");
    r.write("notes/ignored.md", "x\n");
    const adapter = new LocalGitAdapter({ cwd: r.dir, target: { mode: "workspace" } });
    expect(await adapter.listFiles("notes")).toEqual(["notes/a.md", "notes/new.md"]);
  });

  it("lists nothing for a missing directory or one outside the repository", async () => {
    const r = scratch.create();
    const head = r.commit("first", { "a.md": "a\n" });
    const adapter = new LocalGitAdapter({ cwd: r.dir, target: { mode: "commit", commit: head } });
    expect(await adapter.listFiles("missing")).toEqual([]);
    expect(await adapter.listFiles("../elsewhere")).toEqual([]);
  });
});
