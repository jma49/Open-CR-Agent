import { scratchRepos } from "@open-cr-agent/test-support";
import { afterEach, describe, expect, it } from "vitest";
import { blobReader, resolveCommit, revisionFiles } from "./tree.js";

const repos = scratchRepos("ocra-tree-");
afterEach(repos.removeAll);

describe("revisionFiles", () => {
  it("lists a commit's files with their blob ids and sizes, without links", async () => {
    const r = repos.create();
    r.write("a.ts", "export const a = 1;\n");
    r.write("dir/b c.py", "b = 2\n");
    r.commit("c");
    // A symbolic link, added to the index so the test needs no link support.
    const target = r.git("rev-parse", "HEAD:a.ts");
    r.git("update-index", "--add", "--cacheinfo", `120000,${target},link.ts`);
    r.git("commit", "-q", "-m", "link");
    const one = r.git("rev-parse", "HEAD");
    r.commit("c", { "a.ts": "changed\n" });
    const files = await revisionFiles(r.dir, one);
    expect(files.map((f) => f.path)).toEqual(["a.ts", "dir/b c.py"]);
    expect(files[0]).toEqual({
      path: "a.ts",
      blobId: r.git("rev-parse", `${one}:a.ts`),
      size: "export const a = 1;\n".length,
    });
  });

  it("resolves a revision to its commit and refuses an option", async () => {
    const r = repos.create();
    const one = r.commit("c", { "a.ts": "1" });
    expect(await resolveCommit(r.dir, "HEAD")).toBe(one);
    await expect(resolveCommit(r.dir, "--output=x")).rejects.toThrow();
  });
});

describe("blobReader", () => {
  it("reads a blob's bytes, and nothing for a missing, oversized or malformed id", async () => {
    const r = repos.create();
    const one = r.commit("c", { "a.ts": "hello\n", "big.ts": "x".repeat(100) });
    const read = blobReader(r.dir, 50);
    const bytes = await read(r.git("rev-parse", `${one}:a.ts`));
    expect(new TextDecoder().decode(bytes)).toBe("hello\n");
    expect(await read(r.git("rev-parse", `${one}:big.ts`))).toBeUndefined();
    expect(await read("e".repeat(40))).toBeUndefined();
    expect(await read("--batch")).toBeUndefined();
  });
});
