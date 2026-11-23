import { afterEach, describe, expect, it, vi } from "vitest";
import { SharedStarts } from "./shared-starts.js";

const signal = () => new AbortController().signal;

// Whether the claim is still waiting once the pending microtasks have run.
async function waits(claim: Promise<unknown>): Promise<boolean> {
  let waiting = true;
  void claim.then(() => {
    waiting = false;
  });
  await new Promise((resolve) => setImmediate(resolve));
  return waiting;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("SharedStarts", () => {
  it("lets the first request with a start go, and the others once its answer has begun", async () => {
    const starts = new SharedStarts();
    const begun = await starts.claim(["start"], signal());
    const second = starts.claim(["start"], signal());

    expect(await waits(second)).toBe(true);
    begun();

    expect(await waits(second)).toBe(false);
    expect(await waits(starts.claim(["start"], signal()))).toBe(false);
  });

  it("holds nothing back for another start", async () => {
    const starts = new SharedStarts();
    await starts.claim(["one"], signal());

    expect(await waits(starts.claim(["another"], signal()))).toBe(false);
  });

  it("waits for a longer start another request is storing, after the shorter one", async () => {
    const starts = new SharedStarts();
    const first = await starts.claim(["change", "change files"], signal());
    const other = starts.claim(["change", "change other"], signal());
    const same = starts.claim(["change", "change files"], signal());
    first();
    const otherBegun = await other;
    const third = starts.claim(["change", "change other"], signal());

    expect(await waits(same)).toBe(false);
    expect(await waits(third)).toBe(true);
    otherBegun();
    expect(await waits(third)).toBe(false);
  });

  it("stops waiting when the request is cancelled", async () => {
    const starts = new SharedStarts();
    await starts.claim(["start"], signal());
    const cancelled = new AbortController();
    const second = starts.claim(["start"], cancelled.signal);

    cancelled.abort();

    expect(await waits(second)).toBe(false);
  });

  it("stops waiting for an answer that is slow to begin", async () => {
    vi.useFakeTimers();
    const starts = new SharedStarts();
    await starts.claim(["start"], signal());
    const second = starts.claim(["start"], signal());

    await vi.advanceTimersByTimeAsync(10_000);

    await expect(second).resolves.toBeTypeOf("function");
  });
});
