import { serializeGraph, updateGraph } from "@open-cr-agent/code-graph";
import { describe, expect, it } from "vitest";
import graphs from "../../../cloud-contract/fixtures/graphs.json" with { type: "json" };
import { machine } from "./client.fakes.js";
import { fetchCloudGraph } from "./graph.js";

const REPOS = "/api/graphs/repos";
const [github, gitlab] = graphs.answer.repos;
const GRAPH = `${REPOS}/${github?.id}/graph`;
const COMMIT = "2".repeat(40);

async function storedGraph(): Promise<string> {
  const source = new TextEncoder().encode("export const answer = 42;\n");
  const { graph } = await updateGraph(
    undefined,
    [{ path: "src/answer.ts", blobId: "b1" }],
    async () => source,
    { revision: COMMIT },
  );
  return serializeGraph(graph);
}

async function fetched(routes: Parameters<typeof machine>[0], repository: string, signedIn = true) {
  const { deps, calls } = machine(routes, signedIn ? {} : undefined);
  const warnings: string[] = [];
  const graph = await fetchCloudGraph(deps, repository, (w) => warnings.push(w));
  return { graph, warnings, calls: calls.map((c) => c.path) };
}

describe("ocra Cloud's code graph", () => {
  it("is the newest graph of the repository whose host and path are origin's", async () => {
    const { graph, warnings, calls } = await fetched(
      {
        [REPOS]: Response.json(graphs.answer),
        [GRAPH]: new Response(await storedGraph(), { headers: { "x-ocra-graph-commit": COMMIT } }),
      },
      "https://github.com/octo/app",
    );
    expect(warnings).toEqual([]);
    expect(calls).toEqual([REPOS, GRAPH]);
    expect(graph?.commit).toBe(COMMIT);
    expect([...(graph?.graph.files.keys() ?? [])]).toEqual(["src/answer.ts"]);
  });

  it("matches a GitLab group path on its own host, in any case", async () => {
    const { calls } = await fetched(
      { [REPOS]: Response.json(graphs.answer) },
      "https://git.example.com/platform/services/api",
    );
    expect(calls).toEqual([REPOS, `${REPOS}/${gitlab?.id}/graph`]);
  });

  it("skips a repository of a platform this version does not know", async () => {
    const unknown = { ...github, platform: "gitea" };
    const { graph, warnings, calls } = await fetched(
      { [REPOS]: Response.json({ repos: [unknown] }) },
      "https://github.com/octo/app",
    );
    expect(graph).toBeUndefined();
    expect(calls).toEqual([REPOS]);
    expect(warnings).toEqual([
      "could not use ocra Cloud's code graph (it keeps none of https://github.com/octo/app); building it here",
    ]);
  });

  it("says why when there is none to use", async () => {
    const reasons = async (...args: Parameters<typeof fetched>) =>
      (await fetched(...args)).warnings;
    expect(await reasons({}, "https://github.com/octo/app", false)).toEqual([
      expect.stringContaining("(not signed in: run ocra login)"),
    ]);
    expect(await reasons({}, "https://github.com/octo/app")).toEqual([
      expect.stringContaining("(this server keeps no code graphs)"),
    ]);
    expect(
      await reasons({ [REPOS]: Response.json(graphs.answer) }, "https://github.com/octo/app"),
    ).toEqual([expect.stringContaining("(it has not built one yet)")]);
    expect(
      await reasons(
        { [REPOS]: Response.json(graphs.answer), [GRAPH]: new Response('{"format":99}') },
        "https://github.com/octo/app",
      ),
    ).toEqual([expect.stringContaining("(not a code graph this version of ocra reads)")]);
    expect(
      await reasons(
        { [REPOS]: new Response("busy", { status: 503 }) },
        "https://github.com/octo/app",
      ),
    ).toEqual([expect.stringContaining("(HTTP 503)")]);
  });
});
