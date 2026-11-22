import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { graphReferences, parseGraph } from "@open-cr-agent/code-graph";
import { scratchRepos } from "@open-cr-agent/test-support";
import { afterEach, describe, expect, it } from "vitest";
import { machine } from "../cloud/client.fakes.js";
import type { Output } from "../io/output.js";
import { graphCommand as run } from "./graph.js";

const repos = scratchRepos("ocra-graph-");
afterEach(repos.removeAll);

function capture() {
  let text = "";
  return { write: (chunk: string) => (text += chunk), text: () => text };
}

const signedOut = machine({}).deps;
const graphCommand = (argv: string[], out: Output, err: Output, cwd: string) =>
  run(argv, out, err, cwd, signedOut);

const RETRY = "export function parseRetries(input: string): number {\n  return Number(input);\n}\n";
const API =
  "import { parseRetries } from './retry';\nexport const handle = (h: string) => parseRetries(h);\n";

describe("ocra graph", () => {
  it("writes a commit's graph, then updates it parsing only what changed", async () => {
    const r = repos.create();
    const first = r.commit("c", { "src/retry.ts": RETRY, "src/api.ts": API, "README.md": "# app" });
    const file = join(repos.create().dir, "graph.json");
    const out = capture();
    expect(await graphCommand(["--out", file], out, capture(), r.dir)).toBe(0);
    expect(out.text()).toBe(
      `Code graph of ${first.slice(0, 12)}: 2 files (2 parsed, 0 reused) in ${file}\n`,
    );
    const second = r.commit("c", { "src/api.ts": `${API}// more\n` });
    const again = capture();
    await graphCommand(["--out", file], again, capture(), r.dir);
    expect(again.text()).toContain("2 files (1 parsed, 1 reused)");
    const graph = parseGraph(readFileSync(file, "utf8"));
    if (!graph) throw new Error("not a graph");
    expect(graph.revision).toBe(second);
    expect(await graphReferences(graph).usesOf("src/retry.ts", "parseRetries")).toEqual([
      { path: "src/api.ts", line: 1 },
      { path: "src/api.ts", line: 2 },
    ]);
  });

  it("starts from ocra Cloud's graph with --cloud, parsing only what changed since", async () => {
    const r = repos.create();
    execFileSync("git", ["-C", r.dir, "remote", "add", "origin", "git@github.com:Octo/App.git"]);
    const built = r.commit("c", { "src/retry.ts": RETRY, "src/api.ts": API });
    const stored = join(repos.create().dir, "stored.json");
    await graphCommand(["--out", stored], capture(), capture(), r.dir);
    r.commit("c", { "src/api.ts": `${API}// more\n` });
    const { deps } = machine(
      {
        "/api/graphs/repos": Response.json({
          repos: [
            {
              id: "g1",
              platform: "github",
              host: "github.com",
              fullName: "octo/app",
              branch: "main",
              latest: null,
            },
          ],
        }),
        "/api/graphs/repos/g1/graph": new Response(readFileSync(stored, "utf8"), {
          headers: { "x-ocra-graph-commit": built },
        }),
      },
      {},
    );
    const file = join(repos.create().dir, "graph.json");
    const out = capture();
    const err = capture();
    expect(await run(["--out", file, "--cloud"], out, err, r.dir, deps)).toBe(0);
    expect(err.text()).toBe("");
    expect(out.text()).toContain(
      `2 files (1 parsed, 1 reused, started from ocra Cloud's graph of ${built.slice(0, 12)})`,
    );
  });

  it("builds the graph here when ocra Cloud has none to give", async () => {
    const r = repos.create();
    r.commit("c", { "a.ts": RETRY });
    const file = join(repos.create().dir, "graph.json");
    const out = capture();
    const err = capture();
    expect(await graphCommand(["--out", file, "--cloud"], out, err, r.dir)).toBe(0);
    expect(err.text()).toContain("[ocra] could not use ocra Cloud's code graph (not signed in");
    expect(out.text()).toContain("1 file (1 parsed, 0 reused)");
  });

  it("builds an older commit with --rev, and starts over from a file it cannot read", async () => {
    const r = repos.create();
    const first = r.commit("c", { "a.ts": RETRY });
    r.commit("c", { "b.ts": API });
    const file = join(repos.create().dir, "graph.json");
    writeFileSync(file, "{not a graph");
    const out = capture();
    const err = capture();
    await graphCommand(["--out", file, "--rev", first], out, err, r.dir);
    expect(err.text()).toContain("Building the graph again");
    expect(out.text()).toContain(
      `Code graph of ${first.slice(0, 12)}: 1 file (1 parsed, 0 reused)`,
    );
  });

  it("refuses a missing --out or an empty --rev", async () => {
    const r = repos.create();
    r.commit("c", { "a.ts": RETRY });
    await expect(graphCommand([], capture(), capture(), r.dir)).rejects.toThrow(
      "--out needs a file",
    );
    await expect(
      graphCommand(["--out", "g.json", "--rev", ""], capture(), capture(), r.dir),
    ).rejects.toThrow("--rev needs a commit");
  });
});
