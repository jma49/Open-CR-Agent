import { describe, expect, it } from "vitest";
import { executeShown } from "./deliver.js";
import type { ExecutedRun } from "./execute-run.js";
import type { ResolvedRun } from "./resolve-run.js";

function fakeRun(platform: "github" | "local", publish = true) {
  const events: string[] = [];
  const warnings: string[] = [];
  const run = {
    target: { platform, publish },
    warn: (w: string) => warnings.push(w),
    vcs: {
      started: async () => {
        events.push("started");
        return { warnings: ["no checks permission"] };
      },
      stopped: async (reason: string) => {
        events.push(`stopped: ${reason}`);
        return { warnings: [] };
      },
    },
  } as unknown as ResolvedRun;
  return { run, events, warnings };
}

const executed = (interrupted: boolean) => ({ interrupted }) as unknown as ExecutedRun;

describe("executeShown", () => {
  it("shows a published review running and passes on what the platform warned", async () => {
    const { run, events, warnings } = fakeRun("github");
    await executeShown(run, async () => executed(false));
    expect(events).toEqual(["started"]);
    expect(warnings).toEqual(["no checks permission"]);
  });

  it("says the review stopped when it is interrupted or fails", async () => {
    const interrupted = fakeRun("github");
    await executeShown(interrupted.run, async () => executed(true));
    expect(interrupted.events).toEqual([
      "started",
      "stopped: The review was interrupted before it finished.",
    ]);
    const failed = fakeRun("github");
    await expect(
      executeShown(failed.run, async () => {
        throw new Error("quota");
      }),
    ).rejects.toThrow("quota");
    expect(failed.events).toEqual(["started", "stopped: The review failed: quota"]);
  });

  it("shows nothing for a review that is not published", async () => {
    for (const { run, events } of [fakeRun("local"), fakeRun("github", false)]) {
      await executeShown(run, async () => executed(false));
      expect(events).toEqual([]);
    }
  });
});
