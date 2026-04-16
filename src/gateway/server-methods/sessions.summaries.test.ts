import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../config/config.js", () => ({
  loadConfig: vi.fn(() => ({
    agents: {
      list: [{ id: "main" }, { id: "opus" }],
    },
    session: {},
  })),
}));

import { sessionsHandlers, setSessionSummaryLoaderForTests } from "./sessions.js";

describe("sessions.summaries", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-15T10:20:30.000Z"));
    setSessionSummaryLoaderForTests(undefined);
  });

  afterEach(() => {
    setSessionSummaryLoaderForTests(undefined);
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("returns unavailable when the summary backend is missing", async () => {
    setSessionSummaryLoaderForTests(async () => null);
    const respond = vi.fn();

    await sessionsHandlers["sessions.summaries"]({
      params: {},
      respond,
    } as unknown as Parameters<(typeof sessionsHandlers)["sessions.summaries"]>[0]);

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "UNAVAILABLE",
        message: expect.stringContaining("not available"),
      }),
    );
  });

  it("formats rows from the summary loader and derives agentId from the session key", async () => {
    const querySummaries = vi.fn().mockReturnValue([
      {
        session_id: "session-json",
        session_key: "agent:opus:task:123",
        created_at: 1_700_000_000_000,
        ended_at: 1_700_000_100_000,
        message_count: 42,
        summary: JSON.stringify({ overview: "Recovered deploy context" }),
        model: "gpt-5",
        summary_model: "gpt-5-mini",
      },
      {
        session_id: "session-text",
        session_key: "agent:opus:task:456",
        created_at: 1_700_000_200_000,
        ended_at: 1_700_000_300_000,
        message_count: 8,
        summary: "Plain text summary",
        model: null,
        summary_model: null,
      },
    ]);
    setSessionSummaryLoaderForTests(async () => ({ querySummaries }));
    const respond = vi.fn();

    await sessionsHandlers["sessions.summaries"]({
      params: {
        sessionKey: "agent:opus:%subagent%",
        from: "30d",
        to: "now",
        limit: 2,
        query: "deploy fix",
      },
      respond,
    } as unknown as Parameters<(typeof sessionsHandlers)["sessions.summaries"]>[0]);

    expect(querySummaries).toHaveBeenCalledWith({
      agentId: "opus",
      sessionKey: "agent:opus:%subagent%",
      from: Date.UTC(2026, 2, 16, 10, 20, 30),
      to: Date.UTC(2026, 3, 15, 10, 20, 30),
      limit: 2,
      query: "deploy fix",
    });
    expect(respond).toHaveBeenCalledWith(
      true,
      {
        summaries: [
          {
            sessionId: "session-json",
            sessionKey: "agent:opus:task:123",
            createdAt: 1_700_000_000_000,
            endedAt: 1_700_000_100_000,
            messageCount: 42,
            model: "gpt-5",
            summaryModel: "gpt-5-mini",
            summary: { overview: "Recovered deploy context" },
          },
          {
            sessionId: "session-text",
            sessionKey: "agent:opus:task:456",
            createdAt: 1_700_000_200_000,
            endedAt: 1_700_000_300_000,
            messageCount: 8,
            model: null,
            summaryModel: null,
            summary: "Plain text summary",
          },
        ],
      },
      undefined,
    );
  });
});
