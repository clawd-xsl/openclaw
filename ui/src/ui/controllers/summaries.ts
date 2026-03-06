import type { GatewayBrowserClient } from "../gateway.ts";

export type SummaryEntry = {
  sessionId: string;
  sessionKey: string;
  createdAt: number;
  endedAt: number;
  messageCount: number;
  model: string | null;
  summaryModel: string | null;
  summary: unknown;
};

export type SummariesState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  summariesLoading: boolean;
  summariesResult: SummaryEntry[] | null;
  summariesError: string | null;
  summariesFilterKey: string;
  summariesFilterQuery: string;
  summariesFilterFrom: string;
  summariesFilterTo: string;
  summariesPage: number;
  summariesPageSize: number;
};

export async function loadSummaries(
  state: SummariesState,
  overrides?: {
    sessionKey?: string;
    query?: string;
    from?: string;
    to?: string;
  },
) {
  if (!state.client || !state.connected) {
    return;
  }
  if (state.summariesLoading) {
    return;
  }
  state.summariesLoading = true;
  state.summariesError = null;
  try {
    const sessionKey = overrides?.sessionKey ?? (state.summariesFilterKey || "*");
    const query = overrides?.query ?? (state.summariesFilterQuery || undefined);
    const from = overrides?.from ?? (state.summariesFilterFrom || "30d");
    const to = overrides?.to ?? (state.summariesFilterTo || "now");

    const params: Record<string, unknown> = {
      sessionKey,
      from,
      to,
      limit: 1000,
    };
    if (query) {
      params.query = query;
    }
    const res = await state.client.request<{ summaries: SummaryEntry[] } | undefined>(
      "sessions.summaries",
      params,
    );
    if (res?.summaries) {
      state.summariesResult = res.summaries;
    }
  } catch (err) {
    state.summariesError = String(err);
  } finally {
    state.summariesLoading = false;
  }
}

/** Get the current page's slice of results */
export function getPagedResults(state: SummariesState): SummaryEntry[] {
  if (!state.summariesResult) {
    return [];
  }
  const start = state.summariesPage * state.summariesPageSize;
  return state.summariesResult.slice(start, start + state.summariesPageSize);
}

/** Total number of pages */
export function getTotalPages(state: SummariesState): number {
  if (!state.summariesResult) {
    return 0;
  }
  return Math.ceil(state.summariesResult.length / state.summariesPageSize);
}
