import { describe, expect, it } from "vitest";
import { agentsMdReviewer } from "../review/reviewers/agents-md.js";
import { correctnessReviewer } from "../review/reviewers/correctness.js";
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
          stages: { verify: false },
        })
      ).tasks.length;
    const planned = async (adapter: typeof without) =>
      (await previewReview({ vcs: adapter, reviewers: [agentsMdReviewer] })).tasks.length;
    expect(await tasks(withGuidelines)).toBe(1);
    expect(await tasks(without)).toBe(0);
    expect(await planned(withGuidelines)).toBe(1);
    expect(await planned(without)).toBe(0);
  });

  it("gives each reviewer the sections its scope allows", async () => {
    const agents = "# Rules\n\nTest everything.\n\n## `web/`\n\nUse the tokens.";
    const prompts = async (guidelineScope?: "matched" | "reviewer") => {
      const rt = runtime(async function* (spec) {
        yield { type: "done", taskId: spec.taskId };
      });
      await review({
        vcs: vcs({ "AGENTS.md": agents }, liteChange),
        runtime: rt,
        reviewers: [correctnessReviewer, agentsMdReviewer],
        stages: { verify: false },
        ...(guidelineScope ? { guidelineScope } : {}),
      });
      return Object.fromEntries(rt.specs.map((s) => [s.reviewer, s.userPrompt]));
    };
    const all = await prompts();
    expect(all.correctness).toContain("Use the tokens.");
    const matched = await prompts("matched");
    expect(matched.correctness).toContain("Test everything.");
    expect(matched.correctness).not.toContain("Use the tokens.");
    expect(matched.correctness).toContain("- `web/`");
    expect(matched["agents-md"]).toContain("Use the tokens.");
    const reviewer = await prompts("reviewer");
    expect(reviewer.correctness).not.toContain("<ocra_repository_guidelines>");
    expect(reviewer["agents-md"]).toContain("Use the tokens.");
  });
});
