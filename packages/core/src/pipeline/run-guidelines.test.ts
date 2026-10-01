import { describe, expect, it } from "vitest";
import { agentsMdReviewer } from "../review/reviewers/agents-md.js";
import { previewReview } from "./preview.js";
import { runtime, vcs } from "./run.fakes.js";
import { review } from "./run.js";

// Twelve added lines: past the trivial tier, where agents-md starts.
const liteChange = [
  "diff --git a/src/cli.ts b/src/cli.ts",
  "--- a/src/cli.ts",
  "+++ b/src/cli.ts",
  "@@ -1 +1,13 @@",
  " keep",
  ...Array.from({ length: 12 }, (_, i) => `+export const flag${i} = ${i};`),
].join("\n");

const done = runtime(async function* (spec) {
  yield { type: "done", taskId: spec.taskId };
});

describe("the agents-md reviewer and the repository's guidelines", () => {
  it("runs only when the reviewed repository has AGENTS.md, in a run and in --plan", async () => {
    const withGuidelines = vcs({ "AGENTS.md": "Build with npm run build." }, liteChange);
    const without = vcs({}, liteChange);
    const tasks = async (adapter: typeof without) =>
      (
        await review({
          vcs: adapter,
          runtime: done,
          reviewers: [agentsMdReviewer],
          verify: false,
        })
      ).tasks.length;
    const planned = async (adapter: typeof without) =>
      (await previewReview({ vcs: adapter, reviewers: [agentsMdReviewer] })).tasks.length;
    expect(await tasks(withGuidelines)).toBe(1);
    expect(await tasks(without)).toBe(0);
    expect(await planned(withGuidelines)).toBe(1);
    expect(await planned(without)).toBe(0);
  });
});
