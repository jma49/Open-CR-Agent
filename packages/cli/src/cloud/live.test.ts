import { type LiveBatch, liveBatchSchema, readReviewEvent } from "@open-cr-agent/cloud-contract";
import type { ReviewEvent } from "@open-cr-agent/core";
import { finding, reviewReport } from "@open-cr-agent/test-support";
import { describe, expect, it } from "vitest";
import { type Answer, machine } from "./client.fakes.js";
import { LiveRelay } from "./live.js";

const run = { repoHash: "a".repeat(64), source: "github" as const };
const runId = "run-1";
const watch = "https://cloud.test/live/run-1";
const ok = () => Response.json({ watch });
const started: ReviewEvent = { type: "run_started", runId } as ReviewEvent;
const found = finding({
  id: "f1",
  file: "src/a.ts",
  title: "Off by one",
  body: "The loop skips the last item.",
});
const finished: ReviewEvent = {
  type: "run_finished",
  report: reviewReport({ runId, findings: [found] }),
} as ReviewEvent;

function relayWith(answers: Answer[]) {
  const cloud = machine({ "/api/live": answers }, {});
  const bodies: LiveBatch[] = [];
  const fetch = cloud.deps.fetch;
  cloud.deps.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    if (init?.body) bodies.push(JSON.parse(String(init.body)));
    return fetch(input, init);
  }) as typeof globalThis.fetch;
  const notices: string[] = [];
  const warnings: string[] = [];
  const relay = new LiveRelay(cloud.deps, run, "pull request #7", {
    flushMs: 60_000,
    closeMs: 2_000,
    notice: (m) => notices.push(m),
    warn: (m) => warnings.push(m),
  });
  const kinds = () => bodies.flatMap((b) => b.events.map((e) => e.kind));
  return { relay, bodies, notices, warnings, kinds };
}

describe("the live relay", () => {
  it("sends a run's events in order, under the contract, and says where to watch once", async () => {
    const { relay, bodies, notices, kinds } = relayWith([ok()]);
    relay.onEvent(started, false);
    relay.onEvent(finished, false);
    await relay.close();
    expect(kinds()).toEqual(["started", "finding", "finished"]);
    for (const body of bodies) {
      expect(liveBatchSchema.safeParse(body).success).toBe(true);
      for (const event of body.events) expect(readReviewEvent(event)).toBeDefined();
    }
    expect(bodies[0]?.run).toEqual(run);
    expect(notices).toEqual([`[ocra] Watch this review live: ${watch}`]);
  });

  it("ends a cancelled run as failed, not finished", async () => {
    const { relay, kinds } = relayWith([ok()]);
    relay.onEvent(started, false);
    relay.onEvent(finished, true);
    await relay.close();
    expect(kinds()).toEqual(["started", "failed"]);
  });

  it("retries a batch the server did not take, then sends the rest after it", async () => {
    const { relay, bodies, warnings } = relayWith([new Response("", { status: 503 }), ok()]);
    relay.onEvent(started, false);
    relay.onEvent(finished, false);
    await relay.close();
    const seqs = bodies.map((b) => b.events.map((e) => e.seq));
    expect(seqs[0]).toEqual(seqs[1]);
    expect(warnings).toEqual([]);
  });

  it("stops with one warning after failing three times in a row", async () => {
    const down = () => new Response("", { status: 503 });
    const { relay, bodies, warnings } = relayWith([down(), down(), down(), ok()]);
    relay.onEvent(started, false);
    await relay.close();
    relay.onEvent(finished, false);
    expect(bodies).toHaveLength(3);
    expect(warnings).toEqual(["stopped relaying this review to ocra Cloud live (HTTP 503)"]);
  });

  it("stops quietly on a server that relays nothing, or that stopped taking the run", async () => {
    for (const answer of [new Response("{}", { status: 404 }), Response.json({})]) {
      const { relay, bodies, warnings, notices } = relayWith([answer]);
      relay.onEvent(started, false);
      await relay.close();
      relay.onEvent(finished, false);
      await relay.close();
      expect(bodies).toHaveLength(1);
      expect([...warnings, ...notices]).toEqual([]);
    }
  });
});
