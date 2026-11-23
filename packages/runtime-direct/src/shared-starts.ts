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

  // The first request with this start gets what to call once its answer has
  // begun, or it has ended without one. Any other gets nothing, after that
  // call, the wait's limit or the signal.
  async claim(start: string, signal: AbortSignal): Promise<(() => void) | undefined> {
    const storing = this.stored.get(start);
    if (!storing) {
      let begun: () => void = () => undefined;
      this.stored.set(
        start,
        new Promise<void>((resolve) => {
          begun = resolve;
        }),
      );
      return begun;
    }
    const waited = new AbortController();
    const limit = setTimeout(MAX_WAIT_MS, undefined, {
      signal: AbortSignal.any([signal, waited.signal]),
    }).catch(() => undefined);
    await Promise.race([storing, limit]);
    waited.abort();
    return undefined;
  }
}
