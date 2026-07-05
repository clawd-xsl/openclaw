// Control UI tests cover paginated session summary history behavior.
import { describe, expect, it, vi } from "vitest";
import { GatewayRequestError } from "../gateway.ts";
import {
  loadSessionSummaries,
  resetSessionSummaryHistory,
  SESSION_SUMMARIES_LIST_METHOD,
  SESSION_SUMMARIES_PAGE_SIZE,
  type SessionSummaryHistoryState,
} from "./summaries.ts";

type TestRequest = (method: string, payload?: unknown) => Promise<unknown>;

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function createState(): {
  state: SessionSummaryHistoryState;
  request: ReturnType<typeof vi.fn<TestRequest>>;
} {
  const request = vi.fn<TestRequest>();
  const state: SessionSummaryHistoryState = {
    client: { request } as unknown as SessionSummaryHistoryState["client"],
    connected: true,
    hello: {
      type: "hello-ok",
      protocol: 4,
      auth: { role: "operator", scopes: [] },
      features: { methods: [SESSION_SUMMARIES_LIST_METHOD] },
    },
    summaryHistoryAgentId: "research",
    summaryHistoryItems: [],
    summaryHistoryNextCursor: null,
    summaryHistoryLoading: false,
    summaryHistoryLoadingMore: false,
    summaryHistoryError: null,
    summaryHistoryUnavailable: false,
    summaryHistorySearchInput: "budget",
    summaryHistoryQuery: "budget",
  };
  return { state, request };
}

function summaryItem(overrides: Record<string, unknown> = {}) {
  return {
    agentId: "research",
    sessionId: "session-1",
    sessionKey: "agent:research:main",
    status: "complete",
    nextSessionId: "session-2",
    endedAt: Date.parse("2026-07-05T12:00:00.000Z"),
    messageCount: 42,
    model: "claude-opus-4-8",
    generatedAt: Date.parse("2026-07-05T12:01:00.000Z"),
    summary: "The research session established a migration budget.",
    attemptCount: 1,
    ...overrides,
  };
}

describe("session summaries controller", () => {
  it("uses fixed-size server search pages and appends by cursor", async () => {
    const { state, request } = createState();
    request
      .mockResolvedValueOnce({
        items: [summaryItem({ endedAt: Date.parse("2026-07-05T12:00:00.000Z") })],
        nextCursor: "cursor-2",
      })
      .mockResolvedValueOnce({
        items: [
          summaryItem({ summary: "Updated summary from the next page." }),
          summaryItem({
            sessionId: "session-3",
            sessionKey: "agent:research:followup",
            status: "processing",
            nextSessionId: null,
            generatedAt: null,
            summary: null,
            messageCount: 7,
            attemptCount: 0,
          }),
        ],
      });

    await loadSessionSummaries(state);

    expect(request).toHaveBeenNthCalledWith(1, SESSION_SUMMARIES_LIST_METHOD, {
      agentId: "research",
      limit: SESSION_SUMMARIES_PAGE_SIZE,
      query: "budget",
    });
    expect(SESSION_SUMMARIES_PAGE_SIZE).toBe(50);
    expect(state.summaryHistoryItems).toHaveLength(1);
    expect(state.summaryHistoryItems[0]?.endedAt).toBe("2026-07-05T12:00:00.000Z");
    expect(state.summaryHistoryNextCursor).toBe("cursor-2");

    await loadSessionSummaries(state, { append: true });

    expect(request).toHaveBeenNthCalledWith(2, SESSION_SUMMARIES_LIST_METHOD, {
      agentId: "research",
      cursor: "cursor-2",
      limit: SESSION_SUMMARIES_PAGE_SIZE,
      query: "budget",
    });
    expect(state.summaryHistoryItems).toHaveLength(2);
    expect(state.summaryHistoryItems[0]?.summary).toBe("Updated summary from the next page.");
    expect(state.summaryHistoryItems[1]?.status).toBe("pending");
    expect(state.summaryHistoryNextCursor).toBeNull();
    expect(state.summaryHistoryLoading).toBe(false);
    expect(state.summaryHistoryLoadingMore).toBe(false);
  });

  it("shows unavailable without requesting a method the gateway does not advertise", async () => {
    const { state, request } = createState();
    state.hello = {
      ...state.hello!,
      features: { methods: ["sessions.list"] },
    };

    await loadSessionSummaries(state);

    expect(request).not.toHaveBeenCalled();
    expect(state.summaryHistoryUnavailable).toBe(true);
    expect(state.summaryHistoryItems).toEqual([]);
    expect(state.summaryHistoryError).toBeNull();
  });

  it("maps an unknown-method response to the unavailable state", async () => {
    const { state, request } = createState();
    request.mockRejectedValue(
      new GatewayRequestError({
        code: "INVALID_REQUEST",
        message: `unknown method: ${SESSION_SUMMARIES_LIST_METHOD}`,
      }),
    );

    await loadSessionSummaries(state);

    expect(state.summaryHistoryUnavailable).toBe(true);
    expect(state.summaryHistoryError).toBeNull();
    expect(state.summaryHistoryLoading).toBe(false);
  });

  it("surfaces malformed response items as an error", async () => {
    const { state, request } = createState();
    request.mockResolvedValue({ items: [{ status: "complete" }] });

    await loadSessionSummaries(state);

    expect(state.summaryHistoryError).toBe("Invalid session summary history item.");
    expect(state.summaryHistoryItems).toEqual([]);
  });

  it.each([
    ["optional strings", { model: 42 }],
    ["optional timestamps", { generatedAt: "not-a-timestamp" }],
    ["required timestamps", { endedAt: "2026-07-05T12:00:00.000Z" }],
    ["safe message counts", { messageCount: Number.MAX_SAFE_INTEGER + 1 }],
    ["safe attempt counts", { attemptCount: Number.MAX_SAFE_INTEGER + 1 }],
  ])("rejects payloads that violate %s", async (_name, overrides) => {
    const { state, request } = createState();
    request.mockResolvedValue({ items: [summaryItem(overrides)] });

    await loadSessionSummaries(state);

    expect(state.summaryHistoryError).toBe("Invalid session summary history item.");
    expect(state.summaryHistoryItems).toEqual([]);
  });

  it("rejects a present invalid pagination cursor", async () => {
    const { state, request } = createState();
    request.mockResolvedValue({ items: [], nextCursor: 42 });

    await loadSessionSummaries(state);

    expect(state.summaryHistoryError).toBe("Invalid session summary history response.");
    expect(state.summaryHistoryNextCursor).toBeNull();
  });

  it("accepts nullable optional fields and an intentionally empty summary", async () => {
    const { state, request } = createState();
    request.mockResolvedValue({
      items: [
        summaryItem({
          generatedAt: null,
          lastError: null,
          model: null,
          nextSessionId: null,
          summary: "",
        }),
      ],
    });

    await loadSessionSummaries(state);

    expect(state.summaryHistoryError).toBeNull();
    expect(state.summaryHistoryItems).toEqual([
      expect.not.objectContaining({
        generatedAt: expect.anything(),
        lastError: expect.anything(),
        model: expect.anything(),
        nextSessionId: expect.anything(),
        summary: expect.anything(),
      }),
    ]);
  });

  it("invalidates an in-flight request when history is reset", async () => {
    const { state, request } = createState();
    const pending = createDeferred<unknown>();
    request.mockReturnValue(pending.promise);

    const load = loadSessionSummaries(state);
    expect(state.summaryHistoryLoading).toBe(true);

    resetSessionSummaryHistory(state);
    pending.resolve({ items: [summaryItem()] });
    await load;

    expect(state.summaryHistoryItems).toEqual([]);
    expect(state.summaryHistoryError).toBeNull();
    expect(state.summaryHistoryLoading).toBe(false);
    expect(state.summaryHistoryLoadingMore).toBe(false);
  });

  it("ignores a response from a replaced gateway client", async () => {
    const { state, request } = createState();
    const pending = createDeferred<unknown>();
    request.mockReturnValue(pending.promise);
    const load = loadSessionSummaries(state);

    state.client = {
      request: vi.fn<TestRequest>(),
    } as unknown as SessionSummaryHistoryState["client"];
    pending.resolve({ items: [summaryItem()] });
    await load;

    expect(state.summaryHistoryItems).toEqual([]);
    expect(state.summaryHistoryError).toBeNull();
    resetSessionSummaryHistory(state);
  });

  it("ignores a stale error after the active filters change", async () => {
    const { state, request } = createState();
    const pending = createDeferred<unknown>();
    request.mockReturnValue(pending.promise);
    const load = loadSessionSummaries(state);

    state.summaryHistoryAgentId = "main";
    state.summaryHistoryQuery = "new query";
    pending.reject(new Error("stale request failed"));
    await load;

    expect(state.summaryHistoryError).toBeNull();
    resetSessionSummaryHistory(state);
  });
});
