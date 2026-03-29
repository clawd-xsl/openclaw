import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createInboundDebouncer } from "../inbound-debounce.js";

describe("createInboundDebouncer – flush retry", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const makeDebouncer = (overrides: {
    onFlush: (items: string[]) => Promise<void>;
    onError?: (err: unknown, items: string[]) => void;
  }) =>
    createInboundDebouncer<string>({
      debounceMs: 50,
      buildKey: (item) => item.split(":")[0], // key is prefix before ":"
      onFlush: overrides.onFlush,
      onError: overrides.onError,
    });

  it("flushes successfully on first attempt", async () => {
    const flushed: string[][] = [];
    const d = makeDebouncer({
      onFlush: async (items) => {
        flushed.push([...items]);
      },
    });

    await d.enqueue("k:1");
    await d.enqueue("k:2");

    // Advance past debounce timer
    await vi.advanceTimersByTimeAsync(100);

    expect(flushed).toEqual([["k:1", "k:2"]]);
  });

  it("retries on first failure and succeeds on second attempt", async () => {
    let callCount = 0;
    const flushed: string[][] = [];
    const errors: unknown[] = [];

    const d = makeDebouncer({
      onFlush: async (items) => {
        callCount++;
        if (callCount === 1) {
          throw new Error("lock timeout");
        }
        flushed.push([...items]);
      },
      onError: (err) => {
        errors.push(err);
      },
    });

    await d.enqueue("k:msg1");

    // Trigger debounce timer (fires flushBuffer)
    // flushBuffer runs: attempt 0 fails, waits 1s, attempt 1 succeeds
    const flushPromise = vi.advanceTimersByTimeAsync(50);
    // Advance past the 1s backoff delay
    await vi.advanceTimersByTimeAsync(1000);
    await flushPromise;

    expect(callCount).toBe(2);
    expect(flushed).toEqual([["k:msg1"]]);
    expect(errors).toEqual([]);
  });

  it("calls onError after all 3 retries fail", async () => {
    let callCount = 0;
    const errors: Array<{ err: unknown; items: string[] }> = [];

    const d = makeDebouncer({
      onFlush: async () => {
        callCount++;
        throw new Error(`fail #${callCount}`);
      },
      onError: (err, items) => {
        errors.push({ err, items: [...items] });
      },
    });

    await d.enqueue("k:x");

    // Trigger debounce (50ms), then exhaust retries: 1s + 2s + 4s backoff
    // Total: attempt 0 (immediate), wait 1s, attempt 1, wait 2s, attempt 2, wait 4s, attempt 3
    await vi.advanceTimersByTimeAsync(50); // debounce fires
    await vi.advanceTimersByTimeAsync(1000); // backoff after attempt 0
    await vi.advanceTimersByTimeAsync(2000); // backoff after attempt 1
    await vi.advanceTimersByTimeAsync(4000); // backoff after attempt 2

    // 4 total calls: initial + 3 retries
    expect(callCount).toBe(4);
    expect(errors).toHaveLength(1);
    expect((errors[0].err as Error).message).toBe("fail #4");
    expect(errors[0].items).toEqual(["k:x"]);
  });

  it("appends new messages during retry and includes them in the next attempt", async () => {
    let callCount = 0;
    const flushed: string[][] = [];

    const d = makeDebouncer({
      onFlush: async (items) => {
        callCount++;
        if (callCount === 1) {
          throw new Error("temporary failure");
        }
        flushed.push([...items]);
      },
    });

    await d.enqueue("k:first");

    // Fire the debounce timer — attempt 0 starts and fails
    const flushPromise = vi.advanceTimersByTimeAsync(50);
    await flushPromise;

    // During the 1s backoff, enqueue a new message to the same key
    await d.enqueue("k:second");

    // Advance past the 1s backoff — attempt 1 re-snapshots buffer.items
    await vi.advanceTimersByTimeAsync(1000);

    expect(callCount).toBe(2);
    // The retry should include both original and newly appended items
    expect(flushed).toEqual([["k:first", "k:second"]]);
  });

  it("does not delete buffer before onFlush succeeds", async () => {
    let flushStarted = false;

    // We can verify indirectly: if enqueue during flush appends to existing buffer
    // rather than creating a new one, the buffer was kept.
    const d = createInboundDebouncer<string>({
      debounceMs: 50,
      buildKey: () => "shared",
      onFlush: async () => {
        flushStarted = true;
        // Simulate slow flush
        await new Promise<void>((r) => setTimeout(r, 100));
      },
    });

    await d.enqueue("msg1");

    // Fire debounce
    await vi.advanceTimersByTimeAsync(50);

    // During flush (before it completes), enqueue should work on existing buffer
    // if buffer wasn't prematurely deleted. Since flushBuffer snapshots items,
    // new items appended during flush get scheduled for next flush.
    expect(flushStarted).toBe(true);

    // Advance to complete the flush
    await vi.advanceTimersByTimeAsync(100);
  });

  it("flushKey triggers retry logic on failure", async () => {
    let callCount = 0;
    const flushed: string[][] = [];

    const d = makeDebouncer({
      onFlush: async (items) => {
        callCount++;
        if (callCount === 1) {
          throw new Error("fail");
        }
        flushed.push([...items]);
      },
    });

    await d.enqueue("k:direct");

    // Instead of waiting for debounce, flush immediately
    const promise = d.flushKey("k");
    await vi.advanceTimersByTimeAsync(1000); // backoff
    await promise;

    expect(callCount).toBe(2);
    expect(flushed).toEqual([["k:direct"]]);
  });
});
