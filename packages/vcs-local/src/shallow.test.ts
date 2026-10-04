import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scratchRepo } from "@open-cr-agent/test-support";
import { afterEach, describe, expect, it } from "vitest";
import { filesChangedSince } from "./history.js";
import { LocalGitAdapter } from "./local-adapter.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

// An upstream with base -> middle -> head, and a depth-1 clone of head into
// which base was then fetched on its own: both commits exist, their history
// does not, as in a CI checkout without fetch-depth: 0.
function shallowClone(): { clone: string; base: string; head: string } {
  const repo = scratchRepo({ prefix: "ocra-upstream-" });
  const upstream = repo.dir;
  const clone = mkdtempSync(join(tmpdir(), "ocra-shallow-"));
  dirs.push(upstream, clone);
  const base = repo.commit("1\n", { "a.ts": "1\n" });
  repo.commit("2\n", { "a.ts": "2\n" });
  const head = repo.commit("3\n", { "a.ts": "3\n" });
  rmSync(clone, { recursive: true });
  execFileSync("git", ["clone", "-q", "--depth", "1", `file://${upstream}`, clone]);
  git(clone, "fetch", "-q", "--depth", "1", "origin", base);
  return { clone, base, head };
}

describe("shallow clones", () => {
  it("say how to fix a missing merge base instead of failing cryptically", async () => {
    const { clone, base, head } = shallowClone();
    const adapter = new LocalGitAdapter({
      cwd: clone,
      target: { mode: "range", from: base, to: head },
    });
    await expect(adapter.getChangeRequest()).rejects.toThrow("fetch-depth: 0");
  });

  it("give that reason for a full re-review, not a force-push", async () => {
    const { clone, base, head } = shallowClone();
    const changed = await filesChangedSince(clone, base, head);
    expect(changed).toEqual({ reason: expect.stringContaining("the clone is shallow") });
  });
});
