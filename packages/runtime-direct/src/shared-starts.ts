import { setTimeout } from "node:timers/promises";

// A wait this long means the storing request is slow to be answered, and
// the requests behind it are worth more sent than held.
const MAX_WAIT_MS = 10_000;

// A provider's prompt cache serves a start only once the answer to the
// request that stored it has begun, so requests sent together each pay to
// store what one of them could have stored for all. The first request with a
// start goes at once; those that come before its answer begins wait for
// that, and read what it stored (ADR-0072).
export class SharedStarts {
  private readonly stored = new Map<string, Promise<void>>();

  // Returns once every start is stored or the request is the first with it:
  // what to call when its answer has begun, or it has ended without one.
  // `starts` are the keys of what the request opens with, shortest first.
  async claim(starts: readonly string[], signal: AbortSignal): Promise<() => void> {
    const first: (() => void)[] = [];
    for (const start of starts) {
      const storing = this.stored.get(start);
      if (storing) {
        await settled(storing, signal);
        continue;
      }
      this.stored.set(start, new Promise<void>((resolve) => first.push(resolve)));
    }
    return () => {
      for (const begun of first) begun();
    };
  }
}

// After the storing answer has begun, the wait's limit or the signal.
async function settled(storing: Promise<void>, signal: AbortSignal): Promise<void> {
  const waited = new AbortController();
  const limit = setTimeout(MAX_WAIT_MS, undefined, {
    signal: AbortSignal.any([signal, waited.signal]),
  }).catch(() => undefined);
  await Promise.race([storing, limit]);
  waited.abort();
}
