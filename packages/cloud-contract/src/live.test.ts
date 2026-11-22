import { describe, expect, it } from "vitest";
import fixture from "../fixtures/events.json" with { type: "json" };
import { liveAnswerSchema, liveBatchSchema, MAX_LIVE_BATCH } from "./live.js";

const run = { repoHash: "a".repeat(64), source: "github" as const };
const events = fixture.events;

describe("a live batch", () => {
  it("carries a run's events, kinds this version does not know included", () => {
    const batch = liveBatchSchema.parse({ run, events });
    expect(batch.events).toHaveLength(events.length);
    expect(batch.events.at(-1)).toEqual(events.at(-1));
  });

  it("holds the events of one run only", () => {
    const other = { ...events[1], runId: "another-run" };
    expect(liveBatchSchema.safeParse({ run, events: [events[0], other] }).success).toBe(false);
  });

  it("is bounded and never empty", () => {
    expect(liveBatchSchema.safeParse({ run, events: [] }).success).toBe(false);
    const many = Array.from({ length: MAX_LIVE_BATCH + 1 }, (_, i) => ({
      ...events[0],
      seq: i + 1,
    }));
    expect(liveBatchSchema.safeParse({ run, events: many }).success).toBe(false);
  });

  it("names a pull request by its repository's address", () => {
    const pr = { repository: "https://github.com/o/r", number: 7 };
    expect(liveBatchSchema.safeParse({ run: { ...run, pullRequest: pr }, events }).success).toBe(
      true,
    );
    const bad = { ...pr, repository: "o/r" };
    expect(liveBatchSchema.safeParse({ run: { ...run, pullRequest: bad }, events }).success).toBe(
      false,
    );
  });
});

describe("the answer to a batch", () => {
  it("keeps a web address to watch at and drops anything else", () => {
    expect(liveAnswerSchema.parse({ watch: "https://app.example/live/x" }).watch).toBe(
      "https://app.example/live/x",
    );
    expect(liveAnswerSchema.parse({ watch: "javascript:alert(1)" }).watch).toBeUndefined();
    expect(liveAnswerSchema.parse({}).watch).toBeUndefined();
  });
});
