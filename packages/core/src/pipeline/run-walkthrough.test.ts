import { describe, expect, it } from "vitest";
import type { CompletionRequest, Usage } from "../contracts.js";
import type { ReviewEvent } from "../report/report.js";
import { patch, runtime, twoFiles, vcs } from "./run.fakes.js";
import { reviewWithHooks } from "./run.js";

const usage = (costUsd: number): Usage => ({
  inputTokens: 7,
  outputTokens: 3,
  reasoningTokens: 0,
  cachedTokens: 0,
  costUsd,
});

const answer = JSON.stringify({
  overview: "Adds two constants.",
  groups: [{ title: "Constants", files: ["src/a.ts", "src/b.ts"], note: "One each." }],
});

function writerRuntime(costUsd = 0.01) {
  const requests: CompletionRequest[] = [];
  const rt = runtime(async function* (spec) {
    yield { type: "done", taskId: spec.taskId };
  });
  rt.complete = async (request) => {
    requests.push(request);
    return { text: request.agent === "writer" ? answer : "[]", usage: usage(costUsd) };
  };
  return Object.assign(rt, { requests });
}

describe("review with a walkthrough", () => {
  it("writes none unless asked", async () => {
    const rt = writerRuntime();
    const report = await reviewWithHooks({ vcs: vcs({}, twoFiles), runtime: rt });
    expect(rt.requests.filter((r) => r.agent === "writer")).toEqual([]);
    expect(report).not.toHaveProperty("walkthrough");
  });

  it("puts the walkthrough in the report and counts what it cost", async () => {
    const rt = writerRuntime(0.02);
    const events: ReviewEvent[] = [];
    const report = await reviewWithHooks({
      vcs: vcs({}, twoFiles),
      runtime: rt,
      stages: { walkthrough: true },
      onEvent: (e) => events.push(e),
    });
    expect(report.walkthrough).toEqual({
      overview: "Adds two constants.",
      groups: [{ title: "Constants", files: ["src/a.ts", "src/b.ts"], note: "One each." }],
    });
    expect(report.usage.costUsd).toBeCloseTo(0.02);
    expect(events).toContainEqual({ type: "usage_reported", usage: usage(0.02) });
  });

  it("covers every selected file, not only those reviewed again", async () => {
    const rt = writerRuntime();
    await reviewWithHooks({
      vcs: vcs({}, [twoFiles, patch("package-lock.json", "{}")].join("\n")),
      runtime: rt,
      stages: { walkthrough: true },
    });
    const user = rt.requests.find((r) => r.agent === "writer")?.user ?? "";
    expect(user).toContain("src/a.ts");
    expect(user).toContain("src/b.ts");
    expect(user).not.toContain("package-lock.json");
  });

  it("is not written once the spend limit is used up", async () => {
    // Grouping four files spends the whole limit before the review starts.
    const rt = writerRuntime(0.01);
    const four = ["a", "b", "c", "d"].map((n) => patch(`src/${n}.ts`, `const ${n} = 1;`));
    const report = await reviewWithHooks({
      vcs: vcs({}, four.join("\n")),
      runtime: rt,
      stages: { walkthrough: true },
      limits: { maxCostUsd: 0.01 },
    });
    expect(rt.requests.map((r) => r.agent)).toContain("helper");
    expect(rt.requests.filter((r) => r.agent === "writer")).toEqual([]);
    expect(report).not.toHaveProperty("walkthrough");
  });
});
