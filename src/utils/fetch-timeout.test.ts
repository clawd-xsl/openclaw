import { describe, expect, it, vi } from "vitest";
import { fetchWithTimeout } from "./fetch-timeout.js";

describe("fetchWithTimeout", () => {
  it("preserves an upstream abort signal", async () => {
    const upstreamAbort = new AbortController();
    let seenSignal: AbortSignal | undefined;
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      seenSignal = init?.signal as AbortSignal | undefined;
      await new Promise<void>((resolve, reject) => {
        seenSignal?.addEventListener(
          "abort",
          () => reject(seenSignal.reason ?? new DOMException("Aborted", "AbortError")),
          { once: true },
        );
      });
      return new Response("ok", { status: 200 });
    });

    const pending = fetchWithTimeout(
      "https://example.test",
      { signal: upstreamAbort.signal },
      5_000,
      fetchMock,
    );

    expect(seenSignal).toBeDefined();
    expect(seenSignal).not.toBe(upstreamAbort.signal);
    upstreamAbort.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(seenSignal?.aborted).toBe(true);
  });
});
