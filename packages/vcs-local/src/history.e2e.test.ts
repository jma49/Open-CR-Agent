import { scratchRepos } from "@open-cr-agent/test-support";
import { afterEach, describe, expect, it } from "vitest";
import { filesChangedSince } from "./history.js";

const repos = scratchRepos("ocra-history-");
afterEach(repos.removeAll);

describe("filesChangedSince", () => {
  it("lists the files changed between an ancestor and a descendant", async () => {
    const r = repos.create();
    const one = r.commit("c", { "a.ts": "1", "b.ts": "1" });
    const two = r.commit("c", { "b.ts": "2", "c d.ts": "new" });
    expect(await filesChangedSince(r.dir, one, two)).toEqual({ files: ["b.ts", "c d.ts"] });
    expect(await filesChangedSince(r.dir, two, two)).toEqual({ files: [] });
  });

  it("gives a reason for rewritten history, missing commits and non-ids", async () => {
    const r = repos.create();
    const base = r.commit("c", { "a.ts": "1" });
    const old = r.commit("c", { "a.ts": "2" });
    r.git("reset", "-q", "--hard", base);
    const rewritten = r.commit("c", { "a.ts": "3" });
    expect(await filesChangedSince(r.dir, old, rewritten)).toEqual({
      reason: `commit ${old.slice(0, 7)} is not an ancestor of the new head (force-push or rebase)`,
    });
    const missing = "e".repeat(40);
    expect(await filesChangedSince(r.dir, missing, rewritten)).toEqual({
      reason: "commit eeeeeee is not available",
    });
    expect(await filesChangedSince(r.dir, "--output=x", rewritten)).toEqual({
      reason: "not a commit id",
    });
  });
});
