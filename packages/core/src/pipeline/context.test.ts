import { describe, expect, it, vi } from "vitest";
import type { VcsAdapter } from "../contracts.js";
import type { FileDiff } from "../domain.js";
import { AccessDeniedError, reviewContext } from "./context.js";

function fakeVcs(): VcsAdapter {
  return {
    name: "fake",
    getChangeRequest: vi.fn(),
    getDiff: vi.fn(),
    readFile: vi.fn(async (path: string) => `content of ${path}`),
    searchCode: vi.fn(async () => [
      { path: "src/a.ts", line: 1, text: "API_KEY" },
      { path: ".env", line: 1, text: "API_KEY=secret" },
      { path: ".git/config", line: 3, text: "url = https://token@host" },
    ]),
    getPriorReview: vi.fn(),
    publish: vi.fn(),
  };
}

const diffs = [
  { oldPath: "src/a.ts", newPath: "src/a.ts", patch: "a-patch" },
  { oldPath: ".env", newPath: ".env", patch: "API_KEY=secret" },
] as FileDiff[];

describe("reviewContext", () => {
  it("reads ordinary files through the adapter with a normalized path", async () => {
    const vcs = fakeVcs();
    const context = reviewContext(vcs, diffs);
    await expect(context.readFile("./src/../src/a.ts")).resolves.toBe("content of src/a.ts");
    expect(context.readDiff("src/a.ts")).toBe("a-patch");
  });

  it.each([
    ".env",
    "config/.env.production",
    "deploy/id_rsa",
    ".git/config",
    "sub/.GIT/HEAD",
    "../outside.txt",
    "/etc/passwd",
    "src\\..\\.env",
  ])("refuses %s without touching the adapter", async (path) => {
    const vcs = fakeVcs();
    const context = reviewContext(vcs, diffs);
    await expect(context.readFile(path)).rejects.toThrow(AccessDeniedError);
    expect(() => context.readDiff(path)).toThrow(AccessDeniedError);
    expect(vcs.readFile).not.toHaveBeenCalled();
  });

  it("drops search matches in secret files and git internals", async () => {
    const context = reviewContext(fakeVcs(), diffs);
    const matches = await context.searchCode("API_KEY");
    expect(matches.map((m) => m.path)).toEqual(["src/a.ts"]);
    expect(JSON.stringify(matches)).not.toContain("secret");
  });
});
