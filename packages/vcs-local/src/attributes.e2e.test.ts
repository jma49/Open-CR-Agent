import { scratchRepos } from "@open-cr-agent/test-support";
import { afterEach, describe, expect, it } from "vitest";
import { LocalGitAdapter } from "./local-adapter.js";

const scratch = scratchRepos("ocra-attributes-");
afterEach(() => scratch.removeAll());

// The reviewed commits, checked out as a pull request review does, may carry
// a .gitattributes that marks their own changes binary to keep them from
// review. Attributes come from the base commit, which the reviewer trusts.
describe("LocalGitAdapter attributes", () => {
  it("does not let the reviewed commits' .gitattributes mark a changed file binary", async () => {
    const r = scratch.create();
    const base = r.commit("base", { "app.js": "a\n" });
    const head = r.commit("head", { "app.js": "a\nb\n", ".gitattributes": "*.js -diff\n" });
    const adapter = new LocalGitAdapter({
      cwd: r.dir,
      target: { mode: "range", from: base, to: head },
    });

    const app = (await adapter.getDiff()).find((d) => d.newPath === "app.js");
    expect(app?.isBinary).toBe(false);
    expect(app?.patch).toContain("+b");
    const commit = new LocalGitAdapter({ cwd: r.dir, target: { mode: "commit", commit: head } });
    expect((await commit.searchCode("b")).map((m) => m.path)).toContain("app.js");
  });

  it("keeps the base commit's attributes", async () => {
    const r = scratch.create();
    const base = r.commit("base", { "gen.js": "a\n", ".gitattributes": "gen.js -diff\n" });
    r.git("rm", "-q", ".gitattributes");
    const head = r.commit("head", { "gen.js": "a\nb\n" });
    const adapter = new LocalGitAdapter({
      cwd: r.dir,
      target: { mode: "range", from: base, to: head },
    });

    const gen = (await adapter.getDiff()).find((d) => d.newPath === "gen.js");
    expect(gen?.isBinary).toBe(true);
  });
});
