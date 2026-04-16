import { afterEach, describe, expect, it, vi } from "vitest";
import { loadSummaries, type SummariesState } from "./summaries.ts";

type RequestFn = (method: string, params?: unknown) => Promise<unknown>;

function createState(request: RequestFn, overrides: Partial<SummariesState> = {}): SummariesState {
  return {
    client: { request } as unknown as SummariesState["client"],
    connected: true,
    summariesLoading: false,
    summariesResult: null,
    summariesError: null,
    summariesFilterKey: "*",
    summariesFilterQuery: "",
    summariesFilterFrom: "30d",
    summariesFilterTo: "now",
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("loadSummaries", () => {
  it("loads summaries with default wildcard filters", async () => {
    const request = vi.fn(async () => ({
      summaries: [
        {
          sessionId: "session-1",
          sessionKey: "agent:main:main",
          createdAt: 1,
          endedAt: 2,
          messageCount: 3,
          model: "gpt-5",
          summaryModel: "gpt-5-mini",
          summary: "Recovered context",
        },
      ],
    }));
    const state = createState(request);

    await loadSummaries(state);

    expect(request).toHaveBeenCalledWith("sessions.summaries", {
      from: "30d",
      to: "now",
      limit: 1000,
    });
    expect(state.summariesResult).toEqual([
      expect.objectContaining({
        sessionId: "session-1",
        summary: "Recovered context",
      }),
    ]);
    expect(state.summariesError).toBeNull();
  });

  it("includes explicit filters when provided", async () => {
    const request = vi.fn(async () => ({ summaries: [] }));
    const state = createState(request, {
      summariesFilterKey: "agent:opus:%subagent%",
      summariesFilterQuery: "deploy fix",
      summariesFilterFrom: "14d",
      summariesFilterTo: "2026-04-15",
    });

    await loadSummaries(state);

    expect(request).toHaveBeenCalledWith("sessions.summaries", {
      sessionKey: "agent:opus:%subagent%",
      query: "deploy fix",
      from: "14d",
      to: "2026-04-15",
      limit: 1000,
    });
  });

  it("captures request errors as UI-facing strings", async () => {
    const request = vi.fn(async () => {
      throw new Error("backend unavailable");
    });
    const state = createState(request);

    await loadSummaries(state);

    expect(state.summariesResult).toBeNull();
    expect(state.summariesError).toBe("backend unavailable");
    expect(state.summariesLoading).toBe(false);
  });
});
