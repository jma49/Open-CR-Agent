import { describe, expect, it } from "vitest";
import { type DoneToolApi, endSessionsAtDoneTool } from "./done-tool.js";

const DONE = "ocra_task_done";

type Event = { type: string; properties?: { id: string; permission: string } };
const asked = (id: string, permission: string): Event => ({
  type: "permission.asked",
  properties: { id, permission },
});

// An OpenCode whose event stream plays each list in turn, one per
// subscription, and then stops the watcher.
function fakeOpencode(streams: readonly (readonly Event[] | Error)[], pending: Event[] = []) {
  const stop = new AbortController();
  const rejected: string[] = [];
  let subscriptions = 0;
  const api = {
    event: {
      subscribe: async () => {
        const events = streams[subscriptions++];
        if (events === undefined) stop.abort();
        if (events instanceof Error) throw events;
        return {
          stream: (async function* () {
            yield* events ?? [];
          })(),
        };
      },
    },
    permission: {
      list: async () => ({ data: pending.map((e) => e.properties) }),
      reply: async ({ requestID, reply }: { requestID: string; reply: string }) => {
        rejected.push(`${reply} ${requestID}`);
        return {};
      },
    },
  } as unknown as DoneToolApi;
  return { api, stop, rejected, subscriptions: () => subscriptions };
}

describe("endSessionsAtDoneTool", () => {
  it("rejects the done tool's requests and leaves every other one unanswered", async () => {
    const opencode = fakeOpencode([
      [asked("p1", DONE), asked("p2", "bash"), asked("p3", "ocra_read_file"), asked("p4", DONE)],
    ]);
    await endSessionsAtDoneTool(opencode.api, DONE, opencode.stop.signal, 0);
    expect(opencode.rejected).toEqual(["reject p1", "reject p4"]);
  });

  it("rejects what was asked before a stream opened", async () => {
    const opencode = fakeOpencode(
      [[{ type: "server.connected" }]],
      [asked("p1", DONE), asked("p2", "bash")],
    );
    await endSessionsAtDoneTool(opencode.api, DONE, opencode.stop.signal, 0);
    expect(opencode.rejected).toEqual(["reject p1"]);
  });

  it("subscribes again when the stream ends or breaks", async () => {
    const opencode = fakeOpencode([[], new Error("connection reset"), [asked("p1", DONE)]]);
    await endSessionsAtDoneTool(opencode.api, DONE, opencode.stop.signal, 0);
    expect(opencode.rejected).toEqual(["reject p1"]);
    expect(opencode.subscriptions()).toBe(4);
  });

  it("does not subscribe once stopped", async () => {
    const opencode = fakeOpencode([[asked("p1", DONE)]]);
    opencode.stop.abort();
    await endSessionsAtDoneTool(opencode.api, DONE, opencode.stop.signal, 0);
    expect(opencode.subscriptions()).toBe(0);
  });
});
