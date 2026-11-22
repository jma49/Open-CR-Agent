import { describe, expect, it } from "vitest";
import graphs from "../fixtures/graphs.json" with { type: "json" };
import { graphRepoSchema, graphReposAnswerSchema } from "./graphs.js";

describe("the repositories a server keeps graphs of", () => {
  it("read every repository of the fixture", () => {
    const { repos } = graphReposAnswerSchema.parse(graphs.answer);
    expect(repos.map((r) => graphRepoSchema.parse(r))).toEqual(graphs.answer.repos);
  });

  it("refuse a platform the client does not know", () => {
    const [repo] = graphs.answer.repos;
    expect(graphRepoSchema.safeParse({ ...repo, platform: "gitea" }).success).toBe(false);
  });
});
