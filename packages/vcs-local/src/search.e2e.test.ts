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

  it("runs one more for those asked while it runs", async () => {
    const { r, adapter } = committed(files);
    const shared = adapter();
    await shared.searchCode("warm-up");
    const trace = join(r.dir, "..", `${process.pid}-waiting-trace.log`);
    process.env.GIT_TRACE = trace;
    const asked = [shared.searchCode("limit")];
    // One turn of the event loop starts the first grep; a second turn could
    // outlast it on a fast machine, and the later searches would not share.
    await new Promise((resolve) => setImmediate(resolve));
    for (const literal of ["retries", "missing", "x[0].y"]) asked.push(shared.searchCode(literal));
    const answers = await Promise.all(asked);
    delete process.env.GIT_TRACE;
    expect(readFileSync(trace, "utf8").match(/built-in: git .*grep/g)).toHaveLength(2);
    expect(answers.map((matches) => matches.length)).toEqual([20, 2, 0, 1]);
  });

  it("answers each when their output together passes what one search reads", async () => {
    const { adapter } = committed({
      "big.txt": "common line\n".repeat(400_000),
      "rare.ts": "rare();\n",
    });
    const shared = adapter();
    const [common, rare] = await Promise.all(["common", "rare"].map((l) => shared.searchCode(l)));
    expect(common).toHaveLength(20);
    expect(rare).toEqual([{ path: "rare.ts", line: 1, text: "rare();" }]);
  });

  it("searches one at a time past a line longer than a search reads", async () => {
    const { adapter } = committed({
      "a.ts": "before();\n",
      "bundle.txt": `minified ${"x".repeat(13 * 1024 * 1024)}\n`,
      "c.ts": "after();\n",
    });
    const shared = adapter();
    const [before, minified, after] = await Promise.all(
      ["before", "minified", "after"].map((l) => shared.searchCode(l)),
    );
    expect(before).toEqual([{ path: "a.ts", line: 1, text: "before();" }]);
    expect(minified).toEqual([]);
    expect(after).toEqual([{ path: "c.ts", line: 1, text: "after();" }]);
  });
});
