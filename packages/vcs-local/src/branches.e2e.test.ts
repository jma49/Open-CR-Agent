import { scratchRepos } from "@open-cr-agent/test-support";
import { afterEach, describe, expect, it } from "vitest";
import { fetchRemoteBranches } from "./branches.js";

const repos = scratchRepos("ocra-branches-");
afterEach(() => repos.removeAll());

function remoteWithBranches() {
  const remote = repos.create();
  remote.commit("feat: start", { "a.ts": "a\n" });
  const shas: Record<string, string> = {};
  for (const name of ["ocra/learnings-1", "ocra/learnings-2", "feature/other"]) {
    remote.git("checkout", "-q", "-b", name, "main");
    shas[name] = remote.commit(`chore: ${name}`, { [`${name}.md`]: `${name}\n` });
  }
  remote.git("checkout", "-q", "main");
  return { remote, shas };
}

describe("fetchRemoteBranches", () => {
  it("lists the remote's branches under the prefix, last name first, and fetches their commits", async () => {
    const { remote, shas } = remoteWithBranches();
    const local = repos.create();
    local.commit("feat: unrelated", { "b.ts": "b\n" });
    local.git("remote", "add", "origin", remote.dir);
    const branches = await fetchRemoteBranches(local.dir, "ocra/learnings-", { max: 5 });
    expect(branches).toEqual([
      { name: "ocra/learnings-2", sha: shas["ocra/learnings-2"] },
      { name: "ocra/learnings-1", sha: shas["ocra/learnings-1"] },
    ]);
    expect(local.git("cat-file", "-t", shas["ocra/learnings-1"] ?? "")).toBe("commit");
    expect(local.git("for-each-ref", "refs/heads", "refs/remotes")).not.toContain("learnings");
  });

  it("takes at most max, and keeps a shallow clone shallow", async () => {
    const { remote, shas } = remoteWithBranches();
    remote.commit("feat: more", { "c.ts": "c\n" });
    const local = repos.create();
    local.git("fetch", "-q", "--depth=1", `file://${remote.dir}`, "main");
    local.git("reset", "-q", "--hard", "FETCH_HEAD");
    local.git("remote", "add", "origin", `file://${remote.dir}`);
    const branches = await fetchRemoteBranches(local.dir, "ocra/learnings-", { max: 1 });
    expect(branches).toEqual([{ name: "ocra/learnings-2", sha: shas["ocra/learnings-2"] }]);
    expect(local.git("rev-parse", "--is-shallow-repository")).toBe("true");
    expect(local.git("cat-file", "-t", shas["ocra/learnings-2"] ?? "")).toBe("commit");
  });

  it("refuses a prefix git could read as an option or a range", async () => {
    const local = repos.create();
    for (const prefix of ["--upload-pack=x", "a..b", ""]) {
      await expect(fetchRemoteBranches(local.dir, prefix, { max: 1 })).rejects.toThrow(
        "Not a branch name prefix",
      );
    }
  });

  it("fails when the remote cannot be read", async () => {
    const local = repos.create();
    local.git("remote", "add", "origin", `${local.dir}/missing`);
    await expect(fetchRemoteBranches(local.dir, "ocra/", { max: 1 })).rejects.toThrow("ls-remote");
  });
});
