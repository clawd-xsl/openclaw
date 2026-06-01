import { describe, expect, it, vi } from "vitest";
import { fetchWithTimeout } from "./fetch-timeout.js";

describe("fetchWithTimeout", () => {
  it("preserves an upstream abort signal", async () => {
    const upstreamAbort = new AbortController();
    let seenSignal: AbortSignal | undefined;
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const requestSignal = init?.signal as AbortSignal | undefined;
      seenSignal = requestSignal;
      await new Promise<void>((resolve, reject) => {
        requestSignal?.addEventListener(
          "abort",
          () => reject(requestSignal.reason ?? new DOMException("Aborted", "AbortError")),
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

    const signal = seenSignal;
    expect(signal).toBeDefined();
    if (!signal) {
      throw new Error("expected fetch signal");
    }
    expect(signal).not.toBe(upstreamAbort.signal);
    upstreamAbort.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(signal.aborted).toBe(true);
  });
});
