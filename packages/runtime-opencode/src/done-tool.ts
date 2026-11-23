import { setTimeout as delay } from "node:timers/promises";
import type { OpencodeClient } from "@opencode-ai/sdk/v2";

const RESUBSCRIBE_MS = 1_000;

export interface DoneToolApi {
  event: Pick<OpencodeClient["event"], "subscribe">;
  permission: Pick<OpencodeClient["permission"], "list" | "reply">;
}

// OpenCode hands every tool result back to the model, the done tool's too:
// one more request per task, carrying the whole conversation, to hear that
// the review is over. A rejected permission is the one way a tool call ends
// its session with the step's usage recorded (aborting loses it), so the
// done tool asks for one (opencode-config.ts) and every such request is
// rejected here. Runs until the signal aborts.
export async function endSessionsAtDoneTool(
  api: DoneToolApi,
  doneTool: string,
  signal: AbortSignal,
  resubscribeMs = RESUBSCRIBE_MS,
): Promise<void> {
  const reject = (requestID: string) =>
    api.permission.reply({ requestID, reply: "reject" }, { signal }).catch(() => {});
  while (!signal.aborted) {
    try {
      const { stream } = await api.event.subscribe({}, { signal });
      for await (const event of stream) {
        if (event.type === "permission.asked") {
          if (event.properties.permission === doneTool) void reject(event.properties.id);
        } else if (event.type === "server.connected") {
          // Whatever was asked while no stream was open, after a reconnect too.
          const pending = await api.permission.list({}, { signal });
          for (const request of pending.data ?? []) {
            if (request.permission === doneTool) void reject(request.id);
          }
        }
      }
    } catch {
      // The stream broke: subscribe again.
    }
    await delay(resubscribeMs, undefined, { signal }).catch(() => {});
  }
}
