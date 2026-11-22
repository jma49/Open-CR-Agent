import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import type { ReviewEvent as WireEvent } from "@open-cr-agent/cloud-contract";
import type { ReviewEvent } from "@open-cr-agent/core";
import { reviewReport } from "@open-cr-agent/test-support";
import { afterEach, describe, expect, it } from "vitest";
import type { RunRequest } from "../commands/review/request.js";
import { type ReviewStarter, Runs } from "./runs.js";
import { serveServer } from "./server.js";

const token = "t".repeat(64);
const open: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((close) => close()));
});

// Starts, waits until released (or cancelled), then finishes with a report.
function gatedReview() {
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const requests: RunRequest[] = [];
  let count = 0;
  const review =
    (request: RunRequest): ReviewStarter =>
    async (signal, onEvent) => {
      requests.push(request);
      const runId = `run-${++count}`;
      const emit = (e: ReviewEvent) => onEvent(e);
      emit({ type: "run_started", runId, changeRequest: reviewReport().changeRequest });
      emit({ type: "stage_started", stage: "select" });
      await Promise.race([
        gate,
        new Promise((resolve) => signal.addEventListener("abort", resolve)),
      ]);
      const report = reviewReport({ runId });
      emit({ type: "run_finished", report });
      return report;
    };
  return { review, release: () => release(), requests };
}

async function serve(review: (request: RunRequest) => ReviewStarter, concurrent = 2) {
  const server = serveServer({ token, review, runs: new Runs({ concurrent, kept: 5 }) });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  open.push(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = (path: string, init: RequestInit = {}, auth = true) =>
    fetch(`${base}${path}`, {
      ...init,
      headers: { ...(auth ? { authorization: `Bearer ${token}` } : {}), ...init.headers },
    });
  const start = async (body: unknown = {}) => {
    const res = await call("/runs", { method: "POST", body: JSON.stringify(body) });
    return { status: res.status, body: (await res.json()) as { runId: string; error?: string } };
  };
  const events = async (runId: string, last?: number): Promise<WireEvent[]> => {
    const res = await call(`/runs/${runId}/events`, {
      headers: last === undefined ? {} : { "last-event-id": String(last) },
    });
    const text = await res.text();
    return text
      .split("\n")
      .filter((l) => l.startsWith("data: "))
      .map((l) => JSON.parse(l.slice(6)));
  };
  return { base, call, start, events };
}

describe("ocra serve", () => {
  it("refuses a request without the token or for another host", async () => {
    const { base, call } = await serve(gatedReview().review);
    expect((await call("/runs", { method: "POST" }, false)).status).toBe(401);
    const status = await new Promise<number | undefined>((resolve) => {
      const req = httpRequest(`${base}/runs`, {
        method: "POST",
        headers: { host: "attacker.example", authorization: `Bearer ${token}` },
      });
      req.on("response", (res) => resolve(res.statusCode));
      req.end();
    });
    expect(status).toBe(421);
  });

  it("streams a run's events to its end, and replays what came after Last-Event-ID", async () => {
    const gated = gatedReview();
    const { start, events } = await serve(gated.review);
    const { status, body } = await start({ target: { mode: "range", from: "main" } });
    expect(status).toBe(201);
    expect(gated.requests).toEqual([{ target: { mode: "range", from: "main", to: "HEAD" } }]);
    const streamed = events(body.runId);
    gated.release();
    const all = await streamed;
    expect(all.map((e) => e.kind)).toEqual(["started", "stage", "finished"]);
    expect(all[0]?.data).toEqual({ target: "main..HEAD" });
    expect((await events(body.runId, 1)).map((e) => e.seq)).toEqual([2, 3]);
  });

  it("cancels a run: it ends with failed, and keeps its partial report", async () => {
    const { start, events, call } = await serve(gatedReview().review);
    const { body } = await start();
    expect((await call(`/runs/${body.runId}/cancel`, { method: "POST" })).status).toBe(202);
    expect((await events(body.runId)).at(-1)).toMatchObject({
      kind: "failed",
      data: { reason: "cancelled" },
    });
    const snapshot = await (await call(`/runs/${body.runId}`)).json();
    expect(snapshot).toMatchObject({ state: "failed", report: { runId: body.runId } });
  });

  it("refuses more runs than it may run at once, and a body it does not know", async () => {
    const { start } = await serve(gatedReview().review, 1);
    expect((await start()).status).toBe(201);
    expect((await start()).status).toBe(429);
    expect((await start({ target: { mode: "commit", commit: "--output=x" } })).status).toBe(400);
    expect((await start({ config: "elsewhere.json" })).status).toBe(400);
  });

  it("counts a review still starting against the limit", async () => {
    const slow = (): ReviewStarter => async (_signal, onEvent) => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      onEvent({
        type: "run_started",
        runId: `run-${Math.random()}`.replace(".", ""),
        changeRequest: reviewReport().changeRequest,
      });
      return new Promise(() => {});
    };
    const { start } = await serve(slow, 1);
    const statuses = (await Promise.all([start(), start()])).map((r) => r.status);
    expect(statuses.sort()).toEqual([201, 429]);
  });

  it("forgets a run only once it ended", async () => {
    const gated = gatedReview();
    const { start, call, events } = await serve(gated.review);
    const { body } = await start();
    expect((await call(`/runs/${body.runId}`, { method: "DELETE" })).status).toBe(409);
    gated.release();
    await events(body.runId);
    expect((await call(`/runs/${body.runId}`, { method: "DELETE" })).status).toBe(204);
    expect((await call(`/runs/${body.runId}`)).status).toBe(404);
  });

  it("answers a review that cannot start with why", async () => {
    const { start } = await serve(() => async () => {
      throw new Error("not a git repository");
    });
    expect(await start()).toEqual({ status: 422, body: { error: "not a git repository" } });
  });
});
