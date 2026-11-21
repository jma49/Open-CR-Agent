import { describe, expect, it } from "vitest";
import fixture from "../fixtures/events.json" with { type: "json" };
import { ENDING_KINDS, type ReviewEvent, readReviewEvent, reviewEventSchema } from "./events.js";
import { MAX_FIELD } from "./limits.js";

const events = fixture.events;
const known = events.slice(0, -1);
const at = (i: number) => structuredClone(known[i]) as Record<string, unknown>;

describe("the live review events", () => {
  it("keep every field of a run's events", () => {
    for (const event of known) expect(reviewEventSchema.parse(event)).toEqual(event);
  });

  it("are numbered from 1 without a gap and end with exactly one ending event", () => {
    const read = events.map(readReviewEvent).filter((e): e is ReviewEvent => e !== undefined);
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i + 1));
    const endings = read.filter((e) => (ENDING_KINDS as readonly string[]).includes(e.kind));
    expect(endings.map((e) => e.kind)).toEqual(["finished"]);
  });

  it("skip a kind a newer engine added, but not a broken envelope", () => {
    const newer = events.at(-1);
    expect(readReviewEvent(newer)).toBeUndefined();
    expect(() => readReviewEvent({ ...newer, seq: 0 })).toThrow();
    expect(() => readReviewEvent({ ...newer, version: 2 })).toThrow();
  });

  it("refuse a known kind whose data does not fit", () => {
    const finding = at(5);
    finding.data = { ...(finding.data as object), severity: "fatal" };
    expect(() => readReviewEvent(finding)).toThrow();
    const file = at(2);
    file.data = { path: "a.ts", status: "skipped" };
    expect(() => readReviewEvent(file)).toThrow();
  });

  it("refuse an event without the envelope", () => {
    for (const key of ["version", "runId", "seq", "at"]) {
      const event = at(0);
      delete event[key];
      expect(reviewEventSchema.safeParse(event).success, key).toBe(false);
    }
    expect(reviewEventSchema.safeParse({ ...at(0), runId: "has spaces" }).success).toBe(false);
  });

  it("bound the text a finding carries", () => {
    const finding = at(5);
    finding.data = { ...(finding.data as object), body: "x".repeat(MAX_FIELD + 1) };
    expect(reviewEventSchema.safeParse(finding).success).toBe(false);
  });
});
