import { readdir } from "node:fs/promises";
import { scratchRepos } from "@open-cr-agent/test-support";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LocalGitAdapter } from "./local-adapter.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, readdir: vi.fn(actual.readdir) };
});

const scratch = scratchRepos("ocra-workspace-reads-");
afterEach(() => {
  scratch.removeAll();
  vi.mocked(readdir).mockClear();
});

describe("LocalGitAdapter workspace reads", () => {
  it("lists each directory once per run, however many of its files are read", async () => {
    const r = scratch.create();
    for (const name of ["a.ts", "b.ts", "c.ts"]) r.write(`src/${name}`, `${name}\n`);
    const adapter = new LocalGitAdapter({ cwd: r.dir, target: { mode: "workspace" } });

    for (const name of ["a.ts", "b.ts", "c.ts", "a.ts"]) {
      expect(await adapter.readFile(`src/${name}`)).toBe(`${name}\n`);
    }
    const listed = vi.mocked(readdir).mock.calls.map(([dir]) => String(dir));
    expect(listed.filter((dir) => dir.endsWith("src"))).toHaveLength(1);
  });

  it("reads a file under a directory whose name is decomposed on disk by git's precomposed path", async () => {
    const r = scratch.create();
    r.write("café/notes.md", "nfd\n");
    const adapter = new LocalGitAdapter({ cwd: r.dir, target: { mode: "workspace" } });
    expect(await adapter.readFile("café/notes.md")).toBe("nfd\n");
  });
});
