import { existsSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { scratchRepos } from "./scratch-repo.js";

const repos = scratchRepos();
afterEach(repos.removeAll);

describe("scratchRepo", () => {
  it("starts on main with a fixed identity, whatever the host's git config", () => {
    const repo = repos.create();
    const head = repo.commit("first", { "a/b.txt": "x\n" });
    expect(head).toMatch(/^[0-9a-f]{40}$/);
    expect(repo.git("rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
    expect(repo.git("log", "-1", "--format=%an <%ae>")).toBe("Test <test@example.com>");
    expect(repo.git("show", "HEAD:a/b.txt")).toBe("x");
  });

  it("adds an origin when asked", () => {
    expect(
      repos.create({ origin: "https://example.com/o/r" }).git("remote", "get-url", "origin"),
    ).toBe("https://example.com/o/r");
  });

  it("removes what it made", () => {
    const own = scratchRepos();
    const { dir } = own.create();
    own.removeAll();
    expect(existsSync(dir)).toBe(false);
  });
});
