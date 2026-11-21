import { readFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { scratchRepos } from "@open-cr-agent/test-support";
import { afterEach, describe, expect, it } from "vitest";
import { GitError, git } from "./git.js";
import { LocalGitAdapter } from "./local-adapter.js";

const scratch = scratchRepos("ocra-blobs-");
afterEach(async () => {
  delete process.env.GIT_TRACE;
  await scratch.removeAll();
});

const FILES: Record<string, string> = {
  "a.ts": "export const a = 1;\n",
  "dir/b.ts": "b\n",
  "with space.ts": "spaced\n",
  "empty.ts": "",
  "utf8.ts": "日本語 🙂\n",
  "no-newline.ts": "last",
};

function committed() {
  const r = scratch.create();
  for (const [path, text] of Object.entries(FILES)) r.write(path, text);
  symlinkSync("a.ts", join(r.dir, "link.ts"));
  const commit = r.commit("init");
  return {
    r,
    commit,
    adapter: new LocalGitAdapter({ cwd: r.dir, target: { mode: "commit", commit } }),
  };
}

async function catFile(root: string, name: string): Promise<string | undefined> {
  try {
    return await git(["cat-file", "blob", name], { cwd: root });
  } catch (error) {
    if (error instanceof GitError) return undefined;
    throw error;
  }
}

describe("LocalGitAdapter.readFile at a commit", () => {
  const paths = [...Object.keys(FILES), "link.ts", "dir", "missing.ts", "dir/../a.ts"];

  it("reads what git cat-file blob reads, one file at a time and many at once", async () => {
    const { r, commit, adapter } = committed();
    const expected = await Promise.all(paths.map((p) => catFile(r.dir, `${commit}:${p}`)));
    expected[paths.indexOf("dir/../a.ts")] = FILES["a.ts"];
    const alone: (string | undefined)[] = [];
    for (const path of paths) alone.push(await adapter.readFile(path));
    expect(alone).toEqual(expected);
    expect(await Promise.all(paths.map((p) => adapter.readFile(p)))).toEqual(expected);
    expect(expected[paths.indexOf("link.ts")]).toBe("a.ts");
    expect(expected[paths.indexOf("dir")]).toBeUndefined();
  });

  it("reads them all through one git process", async () => {
    const { r, adapter } = committed();
    const trace = join(r.dir, "..", `${process.pid}-blobs.log`);
    process.env.GIT_TRACE = trace;
    await Promise.all(Object.keys(FILES).map((p) => adapter.readFile(p)));
    for (const p of Object.keys(FILES)) await adapter.readFile(p);
    delete process.env.GIT_TRACE;
    expect(readFileSync(trace, "utf8").match(/built-in: git cat-file/g)).toHaveLength(1);
  });
});
