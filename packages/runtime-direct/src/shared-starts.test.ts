import { afterEach, describe, expect, it, vi } from "vitest";
import { SharedStarts } from "./shared-starts.js";

const signal = () => new AbortController().signal;

afterEach(() => {
  vi.useRealTimers();
});

describe("SharedStarts", () => {
  it("lets the first request with a start go, and the others once its answer has begun", async () => {
    const starts = new SharedStarts();
    const begun = await starts.claim("start", signal());
    let waiting = true;
    const second = starts.claim("start", signal()).then((claimed) => {
      waiting = false;
      return claimed;
    });

    await Promise.resolve();
    expect(begun).toBeTypeOf("function");
    expect(waiting).toBe(true);

    begun?.();
    expect(await second).toBeUndefined();
    expect(await starts.claim("start", signal())).toBeUndefined();
  });

  it("holds nothing back for another start", async () => {
    const starts = new SharedStarts();
    await starts.claim("one", signal());

    expect(await starts.claim("another", signal())).toBeTypeOf("function");
  });

  it("stops waiting when the request is cancelled", async () => {
    const starts = new SharedStarts();
    await starts.claim("start", signal());
    const cancelled = new AbortController();
    const second = starts.claim("start", cancelled.signal);

    cancelled.abort();

    expect(await second).toBeUndefined();
  });

  it("stops waiting for an answer that is slow to begin", async () => {
    vi.useFakeTimers();
    const starts = new SharedStarts();
    await starts.claim("start", signal());
    const second = starts.claim("start", signal());

    await vi.advanceTimersByTimeAsync(10_000);

    expect(await second).toBeUndefined();
  });
});
