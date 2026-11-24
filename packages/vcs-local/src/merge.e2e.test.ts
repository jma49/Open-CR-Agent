import { scratchRepos } from "@open-cr-agent/test-support";
import { afterEach, describe, expect, it } from "vitest";
import { mergeConflicts } from "./merge.js";

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
