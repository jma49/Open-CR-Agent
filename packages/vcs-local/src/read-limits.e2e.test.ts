import { rmSync } from "node:fs";
import { scratchRepo } from "@open-cr-agent/test-support";
import { afterEach, describe, expect, it } from "vitest";
import { LocalGitAdapter } from "./local-adapter.js";
import { MAX_READ_BYTES } from "./working-tree.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("LocalGitAdapter reads", () => {
  it("reads at most MAX_READ_BYTES of a file, in the working tree and at a commit", async () => {
    const repo = scratchRepo({ prefix: "ocra-big-" });
    const { dir } = repo;
    dirs.push(dir);
    const head = repo.commit("big", { "big.json": "a".repeat(MAX_READ_BYTES + 1_000_000) });

    const workspace = new LocalGitAdapter({ cwd: dir, target: { mode: "workspace" } });
    expect((await workspace.readFile("big.json"))?.length).toBe(MAX_READ_BYTES);
    const commit = new LocalGitAdapter({ cwd: dir, target: { mode: "commit", commit: head } });
    expect((await commit.readFile("big.json"))?.length).toBe(MAX_READ_BYTES);
  });
});
