import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type FakeEndpoint, scriptedEndpoint } from "../../core/src/runtime/conformance.fakes.js";
import { exchangeKey, type Recording, recordingSchema } from "./record.js";

export interface ReplayEndpoint extends FakeEndpoint {
  // The keys of requests no recording answers.
  misses: string[];
}

// Serves the exchanges recorded in `dir` (OCRA_RECORD_DIR) by the request's
// conversation and tools: each request its answers in order, the last again
// once they run out. A request nothing recorded is answered with an error
// saying it is not replayable, which is what a prompt change looks like.
// Answers are as the live endpoint gave them, so a replay is as strict as the
// endpoint was; it says nothing about how a model would answer a new prompt.
export async function replayEndpoint(dir: string): Promise<ReplayEndpoint> {
  const recordings = new Map<string, { answers: Recording["answers"]; served: number }>();
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
    const recording = recordingSchema.parse(JSON.parse(readFileSync(join(dir, file), "utf8")));
    recordings.set(exchangeKey(recording.request), { answers: recording.answers, served: 0 });
  }
  const misses: string[] = [];
  const endpoint = await scriptedEndpoint((request) => {
    const key = exchangeKey(request);
    const recorded = recordings.get(key);
    if (!recorded) {
      misses.push(key);
      return {
        raw: {
          status: 409,
          body: JSON.stringify({
            error: { message: `not replayable: no recorded exchange for request ${key}` },
          }),
        },
      };
    }
    const answer = recorded.answers[Math.min(recorded.served, recorded.answers.length - 1)];
    recorded.served += 1;
    return { raw: answer as Recording["answers"][number] };
  });
  return { ...endpoint, misses };
}
