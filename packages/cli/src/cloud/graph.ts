import { graphRepoSchema, normaliseRemote } from "@open-cr-agent/cloud-contract";
import { type CodeGraph, parseGraph } from "@open-cr-agent/code-graph";
import { errorMessage } from "@open-cr-agent/core";
import { MAX_GRAPH_BYTES } from "../graph/file.js";
import { CloudClient, type CloudResult, sessionLostReason } from "./client.js";
import type { CloudDeps } from "./deps.js";

// The graph a self-hosted ocra Cloud keeps of the repository's default
// branch (ADR-0041), for `ocra graph --cloud` to start from: every file the
// commit did not change since is reused instead of parsed.

export type CloudGraph = { graph: CodeGraph; commit: string | undefined };

/** The newest graph ocra Cloud built of `repository` (normaliseRemote's form); undefined, with a warning, when there is none to use. */
export async function fetchCloudGraph(
  deps: CloudDeps,
  repository: string,
  warn: (message: string) => void,
): Promise<CloudGraph | undefined> {
  const cannot = (reason: string) => {
    warn(`could not use ocra Cloud's code graph (${reason}); building it here`);
    return undefined;
  };
  const client = new CloudClient(deps);
  try {
    const repos = await client.graphRepos();
    if (repos.kind !== "ok")
      return cannot(
        failure(repos, "this server keeps no code graphs", "its answer lists no repositories"),
      );
    const repoId = repos.value
      .flatMap((entry) => {
        const parsed = graphRepoSchema.safeParse(entry);
        return parsed.success ? [parsed.data] : [];
      })
      .find((r) => normaliseRemote(`https://${r.host}/${r.fullName}`) === repository)?.id;
    if (!repoId) return cannot(`it keeps none of ${repository}`);
    const answer = await client.graph(repoId, MAX_GRAPH_BYTES);
    if (answer.kind !== "ok")
      return cannot(
        failure(answer, "it has not built one yet", `larger than ${MAX_GRAPH_BYTES} bytes`),
      );
    const graph = parseGraph(answer.value.text);
    if (!graph) return cannot("not a code graph this version of ocra reads");
    return { graph, commit: answer.value.commit ?? graph.revision };
  } catch (error) {
    return cannot(errorMessage(error));
  }
}

function failure(
  answer: Exclude<CloudResult<unknown>, { kind: "ok" }>,
  notFound: string,
  malformed: string,
): string {
  switch (answer.kind) {
    case "signed-out":
      return "not signed in: run ocra login";
    case "status":
      return answer.status === 404 ? notFound : `HTTP ${answer.status}`;
    case "malformed":
      return malformed;
    default:
      return sessionLostReason(answer);
  }
}
