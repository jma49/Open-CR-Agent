import { readFileSync } from "node:fs";
import { join } from "node:path";
import { scratchRepos } from "@open-cr-agent/test-support";
import { afterEach, describe, expect, it } from "vitest";
import { LocalGitAdapter } from "./local-adapter.js";

const scratch = scratchRepos("ocra-search-");
afterEach(async () => {
  delete process.env.GIT_TRACE;
  await scratch.removeAll();
});

function committed(files: Record<string, string>) {
  const r = scratch.create();
  for (const [path, text] of Object.entries(files)) r.write(path, text);
  const commit = r.commit("init");
  return {
    r,
    adapter: () => new LocalGitAdapter({ cwd: r.dir, target: { mode: "commit", commit } }),
  };
}

const LITERALS = [
  "limit",
  "retries",
  "limit(retries)",
  "--output=x",
  "a\nb",
  "missing",
  "x[0].y",
  "$y{1}+",
  "\\d|^z?*",
  "a.b",
];

describe("searchCode asked several times in one turn", () => {
  const files = {
    "a.ts": `${"limit();\n".repeat(30)}call(limit(retries));\n--output=x\n`,
    "b.ts": "const retries = 3;\na\nb\nx[0].y = $y{1}+ \\d|^z?*;\naxb\n",
  };

  it("answers each literal as a search of its own would", async () => {
    const { adapter } = committed(files);
    const alone: unknown[] = [];
    for (const literal of LITERALS) alone.push(await adapter().searchCode(literal));
    const together = await Promise.all(LITERALS.map((l) => adapter().searchCode(l)));
    const shared = adapter();
    expect(await Promise.all(LITERALS.map((l) => shared.searchCode(l)))).toEqual(alone);
    expect(together).toEqual(alone);
    expect((alone[0] as unknown[]).length).toBe(20);
  });

  it("runs one git grep for them", async () => {
    const { r, adapter } = committed(files);
    const shared = adapter();
    await shared.searchCode("warm-up");
    const trace = join(r.dir, "..", `${process.pid}-trace.log`);
    process.env.GIT_TRACE = trace;
    await Promise.all(["limit", "retries", "missing"].map((l) => shared.searchCode(l)));
    delete process.env.GIT_TRACE;
    expect(readFileSync(trace, "utf8").match(/built-in: git .*grep/g)).toHaveLength(1);
  });

  it("searches one at a time when their output together passes the cap", async () => {
    const { adapter } = committed({
      "big.txt": "common line\n".repeat(400_000),
      "rare.ts": "rare();\n",
    });
    const shared = adapter();
    const [common, rare] = await Promise.all(["common", "rare"].map((l) => shared.searchCode(l)));
    expect(common).toHaveLength(20);
    expect(rare).toEqual([{ path: "rare.ts", line: 1, text: "rare();" }]);
  });
});
