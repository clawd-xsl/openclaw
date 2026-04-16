import { t } from "../../i18n/index.ts";
import type { GatewayBrowserClient } from "../gateway.ts";
import {
  formatMissingOperatorReadScopeMessage,
  isMissingOperatorReadScopeError,
} from "./scope-errors.ts";

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
};

function normalizeSummaryFilter(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim();
  return trimmed ? trimmed : fallback;
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }
  return String(error);
}

export async function loadSummaries(
  state: SummariesState,
  overrides?: {
    sessionKey?: string;
    query?: string;
    from?: string;
    to?: string;
  },
) {
  const client = state.client;
  if (!client || !state.connected || state.summariesLoading) {
    return;
  }

  state.summariesLoading = true;
  state.summariesError = null;
  try {
    const sessionKey = normalizeSummaryFilter(
      overrides?.sessionKey ?? state.summariesFilterKey,
      "*",
    );
    const query = normalizeSummaryFilter(overrides?.query ?? state.summariesFilterQuery, "");
    const from = normalizeSummaryFilter(overrides?.from ?? state.summariesFilterFrom, "30d");
    const to = normalizeSummaryFilter(overrides?.to ?? state.summariesFilterTo, "now");

    const params: Record<string, unknown> = {
      from,
      to,
      limit: 1000,
    };
    if (sessionKey !== "*") {
      params.sessionKey = sessionKey;
    }
    if (query) {
      params.query = query;
    }

    const result = await client.request<{ summaries?: SummaryEntry[] } | undefined>(
      "sessions.summaries",
      params,
    );
    state.summariesResult = Array.isArray(result?.summaries) ? result.summaries : [];
  } catch (error) {
    if (isMissingOperatorReadScopeError(error)) {
      state.summariesResult = null;
      state.summariesError =
        t("summariesPage.missingScope") ??
        formatMissingOperatorReadScopeMessage("session summaries");
    } else {
      state.summariesError = toErrorMessage(error);
    }
  } finally {
    state.summariesLoading = false;
  }
}
