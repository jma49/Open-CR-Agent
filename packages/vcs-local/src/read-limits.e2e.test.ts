import { scratchRepos } from "@open-cr-agent/test-support";
import { afterEach, describe, expect, it } from "vitest";
import { LocalGitAdapter } from "./local-adapter.js";
import { MAX_READ_BYTES } from "./working-tree.js";

const scratch = scratchRepos("ocra-big-");
afterEach(() => scratch.removeAll());

describe("LocalGitAdapter reads", () => {
  it("reads at most MAX_READ_BYTES of a file, in the working tree and at a commit", async () => {
    const repo = scratch.create();
    const { dir } = repo;
    const head = repo.commit("big", { "big.json": "a".repeat(MAX_READ_BYTES + 1_000_000) });

    const workspace = new LocalGitAdapter({ cwd: dir, target: { mode: "workspace" } });
    expect((await workspace.readFile("big.json"))?.length).toBe(MAX_READ_BYTES);
    const commit = new LocalGitAdapter({ cwd: dir, target: { mode: "commit", commit: head } });
    expect((await commit.readFile("big.json"))?.length).toBe(MAX_READ_BYTES);
  });
});
