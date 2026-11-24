import { scratchRepos } from "@open-cr-agent/test-support";
import { afterEach, describe, expect, it } from "vitest";
import { mergeConflicts, pushMerge } from "./merge.js";

const repos = scratchRepos("ocra-merge-");
afterEach(repos.removeAll);

const FILE = ["const limit = 5;", "", "export function run() {", "  return limit;", "}", ""];
const text = (lines: string[]) => lines.join("\n");

// A base commit, then one commit on each side of it.
function diverged(
  base: Record<string, string>,
  ours: Record<string, string>,
  theirs: Record<string, string>,
) {
  const r = repos.create();
  // Git for Windows would store a fixture's carriage returns as line feeds.
  r.git("config", "core.autocrlf", "false");
  const root = r.commit("base", base);
  const mine = r.commit("ours", ours);
  r.git("checkout", "-q", "-b", "target", root);
  const target = r.commit("theirs", theirs);
  return { r, ours: mine, theirs: target };
}

describe("mergeConflicts", () => {
  it("answers nothing when the two sides merge cleanly", async () => {
    const { r, ours, theirs } = diverged(
      { "a.ts": text(FILE) },
      { "a.ts": text(["const limit = 10;", ...FILE.slice(1)]) },
      { "a.ts": text([...FILE.slice(0, 3), "  return limit + 1;", "}", ""]) },
    );
    expect(await mergeConflicts(r.dir, ours, theirs)).toBeUndefined();
  });

  it("gives a conflicted file as a diff3 merge, ours first, and checks nothing out", async () => {
    const { r, ours, theirs } = diverged(
      { "a.ts": text(FILE), "b.ts": "1\n" },
      { "a.ts": text(["const limit = 10;", ...FILE.slice(1)]) },
      { "a.ts": text(["const LIMIT = 5;", ...FILE.slice(1)]), "b.ts": "2\n" },
    );
    const head = r.git("rev-parse", "HEAD").trim();
    const conflicts = await mergeConflicts(r.dir, ours, theirs);
    expect(conflicts?.other).toEqual([]);
    expect(conflicts?.files).toHaveLength(1);
    const [file] = conflicts?.files ?? [];
    expect(file).toMatchObject({ path: "a.ts", markerSize: 7, executable: false });
    const lines = file?.merged.split("\n") ?? [];
    expect(lines.slice(0, 7).map((l) => l.replace(/^([<|>]{7}) .*$/, "$1"))).toEqual([
      "<<<<<<<",
      "const limit = 10;",
      "|||||||",
      "const limit = 5;",
      "=======",
      "const LIMIT = 5;",
      ">>>>>>>",
    ]);
    // No temporary path of this machine reaches a prompt.
    expect([lines[0], lines[2], lines[6]]).toEqual([
      "<<<<<<< ours",
      "||||||| base",
      ">>>>>>> theirs",
    ]);
    expect(r.git("rev-parse", "HEAD").trim()).toBe(head);
    expect(r.git("status", "--porcelain")).toBe("");
  });

  it("uses markers longer than any marker-like line of the file", async () => {
    const marked = ["<<<<<<< kept in a fixture", ...FILE];
    const { r, ours, theirs } = diverged(
      { "a.md": text(marked) },
      { "a.md": text([marked[0] ?? "", "const limit = 10;", ...FILE.slice(1)]) },
      { "a.md": text([marked[0] ?? "", "const LIMIT = 5;", ...FILE.slice(1)]) },
    );
    const [file] = (await mergeConflicts(r.dir, ours, theirs))?.files ?? [];
    expect(file?.markerSize).toBe(8);
    expect(file?.merged).toContain("\n<<<<<<<< ");
    expect(file?.merged.startsWith("<<<<<<< kept in a fixture\n")).toBe(true);
  });

  it("leaves a deleted side, a binary file and carriage returns to a person", async () => {
    const { r, ours, theirs } = diverged(
      { "gone.ts": "1\n", "bin.dat": "a\0b\n", "crlf.txt": "a\r\n" },
      { "gone.ts": "2\n", "bin.dat": "a\0c\n", "crlf.txt": "b\r\n" },
      { "bin.dat": "a\0d\n", "crlf.txt": "c\r\n" },
    );
    r.git("checkout", "-q", "target");
    r.git("rm", "-q", "gone.ts");
    r.git("commit", "-q", "-m", "drop");
    const target = r.git("rev-parse", "HEAD").trim();
    expect(theirs).not.toBe(target);
    const conflicts = await mergeConflicts(r.dir, ours, target);
    expect(conflicts?.files).toEqual([]);
    expect(conflicts?.other.sort()).toEqual(["bin.dat", "crlf.txt", "gone.ts"]);
  });

  it("refuses anything but commit ids", async () => {
    const r = repos.create();
    const one = r.commit("c", { "a.ts": "1" });
    await expect(mergeConflicts(r.dir, "--output=x", one)).rejects.toThrow("two commit ids");
  });
});

describe("pushMerge", () => {
  const author = { name: "ocra[bot]", email: "ocra@example.com" };
  const RESOLVED = text(["const LIMIT = 10;", ...FILE.slice(1)]);

  // The change request's branch and its target on a remote, both fetched
  // into the clone the merge is made in.
  function remoteWith() {
    const {
      r: remote,
      ours,
      theirs,
    } = diverged(
      { "a.ts": text(FILE), "b.ts": "1\n" },
      { "a.ts": text(["const limit = 10;", ...FILE.slice(1)]) },
      { "a.ts": text(["const LIMIT = 5;", ...FILE.slice(1)]), "b.ts": "2\n" },
    );
    remote.git("branch", "feature", ours);
    remote.git("config", "receive.denyCurrentBranch", "ignore");
    const clone = repos.create({ origin: remote.dir });
    clone.git("fetch", "-q", "origin");
    const merge = {
      ours,
      theirs,
      message: "Merge the base branch\n\n- a.ts\n",
      files: [{ path: "a.ts", content: RESOLVED }],
      branch: "feature",
      author,
    };
    return { remote, clone, merge };
  }

  it("pushes one commit with both parents, git's merge and the resolved file", async () => {
    const { remote, clone, merge } = remoteWith();
    const result = await pushMerge(clone.dir, merge);
    if (!result.committed) throw new Error(result.reason);
    expect(remote.git("rev-parse", "feature")).toBe(result.sha);
    expect(remote.git("log", "-1", "--format=%P", "feature")).toBe(`${merge.ours} ${merge.theirs}`);
    expect(remote.git("log", "-1", "--format=%an <%ae>|%cn|%s", "feature")).toBe(
      "ocra[bot] <ocra@example.com>|ocra[bot]|Merge the base branch",
    );
    expect(remote.git("show", "feature:a.ts")).toBe(RESOLVED.trimEnd());
    expect(remote.git("show", "feature:b.ts")).toBe("2");
    expect(clone.git("status", "--porcelain")).toBe("");
    expect(clone.git("branch", "--list")).toBe("");
  });

  it("writes nothing when the branch moved, and never forces", async () => {
    const { remote, clone, merge } = remoteWith();
    remote.git("checkout", "-q", "feature");
    const pushed = remote.commit("a push in between", { "c.ts": "new\n" });
    expect(await pushMerge(clone.dir, merge)).toEqual({
      committed: false,
      outcome: "head_moved",
      reason: "the branch moved after ocra read it",
    });
    expect(remote.git("rev-parse", "feature")).toBe(pushed);
  });

  it("answers not_writable when the remote refuses, without the remote's address", async () => {
    const { remote, clone, merge } = remoteWith();
    clone.git("remote", "set-url", "origin", `${remote.dir}-gone`);
    const result = await pushMerge(clone.dir, merge);
    expect(result).toMatchObject({ committed: false, outcome: "not_writable" });
  });

  it("refuses a merge that leaves a conflicted file out, adds another, or names no branch", async () => {
    const { clone, merge } = remoteWith();
    await expect(pushMerge(clone.dir, { ...merge, files: [] })).rejects.toThrow(
      "every conflicted file",
    );
    const extra = [...merge.files, { path: "b.ts", content: "3\n" }];
    await expect(pushMerge(clone.dir, { ...merge, files: extra })).rejects.toThrow(
      "every conflicted file",
    );
    for (const branch of ["--force", "a..b", "+feature", "x y"]) {
      await expect(pushMerge(clone.dir, { ...merge, branch })).rejects.toThrow("not a branch name");
    }
  });
});
