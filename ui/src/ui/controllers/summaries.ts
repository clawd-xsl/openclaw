// Control UI controller manages paginated session summary history.
import type { GatewayBrowserClient, GatewayHelloOk } from "../gateway.ts";
import { GatewayRequestError } from "../gateway.ts";

export const SESSION_SUMMARIES_LIST_METHOD = "memory.summaries.list";
export const SESSION_SUMMARIES_PAGE_SIZE = 50;

export type SessionSummaryStatus = "pending" | "failed" | "complete";

export type SessionSummaryHistoryItem = {
  agentId: string;
  sessionId: string;
  sessionKey: string;
  status: SessionSummaryStatus;
  nextSessionId?: string;
  endedAt: string;
  messageCount: number;
  model?: string;
  generatedAt?: string;
  summary?: string;
  lastError?: string;
  attemptCount: number;
};

export type SessionSummaryHistoryState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  hello?: GatewayHelloOk | null;
  summaryHistoryAgentId: string | null;
  summaryHistoryItems: SessionSummaryHistoryItem[];
  summaryHistoryNextCursor: string | null;
  summaryHistoryLoading: boolean;
  summaryHistoryLoadingMore: boolean;
  summaryHistoryError: string | null;
  summaryHistoryUnavailable: boolean;
  summaryHistorySearchInput: string;
  summaryHistoryQuery: string;
  summaryHistoryRequestGeneration?: number;
};

type SessionSummaryHistoryResponse = {
  items: SessionSummaryHistoryItem[];
  nextCursor?: string;
};

type OptionalValue<T> = { valid: true; value?: T } | { valid: false };

type SessionSummaryRequest = {
  generation: number;
  client: GatewayBrowserClient;
  agentId: string | undefined;
  query: string;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function normalizeRequiredString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim();
  return normalized || null;
}

function normalizeOptionalString(value: unknown): string | undefined {
  return normalizeRequiredString(value) ?? undefined;
}

function normalizeTimestamp(value: unknown): string | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function normalizeNonNegativeInteger(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    return null;
  }
  return value;
}

function readOptionalString(
  record: Record<string, unknown>,
  key: string,
  options: { allowEmpty?: boolean } = {},
): OptionalValue<string> {
  if (!Object.hasOwn(record, key)) {
    return { valid: true };
  }
  const value = record[key];
  if (value === null) {
    return { valid: true };
  }
  if (typeof value !== "string") {
    return { valid: false };
  }
  const normalized = value.trim();
  if (!normalized) {
    return options.allowEmpty ? { valid: true } : { valid: false };
  }
  return { valid: true, value: normalized };
}

function readOptionalTimestamp(
  record: Record<string, unknown>,
  key: string,
): OptionalValue<string> {
  if (!Object.hasOwn(record, key)) {
    return { valid: true };
  }
  const value = record[key];
  if (value === null) {
    return { valid: true };
  }
  const normalized = normalizeTimestamp(value);
  return normalized ? { valid: true, value: normalized } : { valid: false };
}

function normalizeStatus(value: unknown): SessionSummaryStatus | null {
  if (value === "processing") {
    return "pending";
  }
  return value === "pending" || value === "failed" || value === "complete" ? value : null;
}

function normalizeSummaryItem(value: unknown): SessionSummaryHistoryItem | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }
  const agentId = normalizeRequiredString(record.agentId);
  const sessionId = normalizeRequiredString(record.sessionId);
  const sessionKey = normalizeRequiredString(record.sessionKey);
  const status = normalizeStatus(record.status);
  const endedAt = normalizeTimestamp(record.endedAt);
  const messageCount = normalizeNonNegativeInteger(record.messageCount);
  const attemptCount = normalizeNonNegativeInteger(record.attemptCount);
  if (
    !agentId ||
    !sessionId ||
    !sessionKey ||
    !status ||
    !endedAt ||
    messageCount === null ||
    attemptCount === null
  ) {
    return null;
  }
  const nextSessionId = readOptionalString(record, "nextSessionId");
  const model = readOptionalString(record, "model");
  const generatedAt = readOptionalTimestamp(record, "generatedAt");
  const summary = readOptionalString(record, "summary", { allowEmpty: true });
  const lastError = readOptionalString(record, "lastError");
  if (
    !nextSessionId.valid ||
    !model.valid ||
    !generatedAt.valid ||
    !summary.valid ||
    !lastError.valid
  ) {
    return null;
  }
  return {
    agentId,
    sessionId,
    sessionKey,
    status,
    endedAt,
    messageCount,
    attemptCount,
    ...(nextSessionId.value ? { nextSessionId: nextSessionId.value } : {}),
    ...(model.value ? { model: model.value } : {}),
    ...(generatedAt.value ? { generatedAt: generatedAt.value } : {}),
    ...(summary.value ? { summary: summary.value } : {}),
    ...(lastError.value ? { lastError: lastError.value } : {}),
  };
}

function normalizeSummaryResponse(value: unknown): SessionSummaryHistoryResponse {
  const record = asRecord(value);
  if (!record || !Array.isArray(record.items)) {
    throw new Error("Invalid session summary history response.");
  }
  const items = record.items.map(normalizeSummaryItem);
  if (items.some((item) => item === null)) {
    throw new Error("Invalid session summary history item.");
  }
  let nextCursor: string | undefined;
  if (Object.hasOwn(record, "nextCursor")) {
    nextCursor = normalizeRequiredString(record.nextCursor) ?? undefined;
    if (!nextCursor) {
      throw new Error("Invalid session summary history response.");
    }
  }
  return {
    items: items as SessionSummaryHistoryItem[],
    ...(nextCursor ? { nextCursor } : {}),
  };
}

function isCurrentSummaryRequest(
  state: SessionSummaryHistoryState,
  request: SessionSummaryRequest,
): boolean {
  return (
    state.summaryHistoryRequestGeneration === request.generation &&
    state.client === request.client &&
    normalizeOptionalString(state.summaryHistoryAgentId) === request.agentId &&
    state.summaryHistoryQuery.trim() === request.query
  );
}

function summaryItemKey(item: SessionSummaryHistoryItem): string {
  return `${item.agentId}\u0000${item.sessionId}`;
}

function mergeSummaryPages(
  current: SessionSummaryHistoryItem[],
  incoming: SessionSummaryHistoryItem[],
): SessionSummaryHistoryItem[] {
  const merged = [...current];
  const indexes = new Map(merged.map((item, index) => [summaryItemKey(item), index]));
  for (const item of incoming) {
    const key = summaryItemKey(item);
    const existingIndex = indexes.get(key);
    if (existingIndex === undefined) {
      indexes.set(key, merged.length);
      merged.push(item);
    } else {
      merged[existingIndex] = item;
    }
  }
  return merged;
}

function methodIsAdvertised(state: SessionSummaryHistoryState): boolean {
  const methods = state.hello?.features?.methods;
  return !Array.isArray(methods) || methods.includes(SESSION_SUMMARIES_LIST_METHOD);
}

function isUnknownMethodError(error: unknown): boolean {
  return (
    error instanceof GatewayRequestError &&
    error.gatewayCode === "INVALID_REQUEST" &&
    error.message.includes(`unknown method: ${SESSION_SUMMARIES_LIST_METHOD}`)
  );
}

function markSummaryHistoryUnavailable(state: SessionSummaryHistoryState): void {
  state.summaryHistoryUnavailable = true;
  state.summaryHistoryError = null;
  state.summaryHistoryItems = [];
  state.summaryHistoryNextCursor = null;
}

export function resetSessionSummaryHistory(state: SessionSummaryHistoryState): void {
  state.summaryHistoryRequestGeneration = (state.summaryHistoryRequestGeneration ?? 0) + 1;
  state.summaryHistoryItems = [];
  state.summaryHistoryNextCursor = null;
  state.summaryHistoryLoading = false;
  state.summaryHistoryLoadingMore = false;
  state.summaryHistoryError = null;
  state.summaryHistoryUnavailable = false;
}

export async function loadSessionSummaries(
  state: SessionSummaryHistoryState,
  options: { append?: boolean } = {},
): Promise<void> {
  const client = state.client;
  if (!client || !state.connected) {
    return;
  }
  const append = options.append === true;
  const cursor = append ? state.summaryHistoryNextCursor : null;
  if (append && (!cursor || state.summaryHistoryLoading || state.summaryHistoryLoadingMore)) {
    return;
  }

  const requestGeneration = (state.summaryHistoryRequestGeneration ?? 0) + 1;
  state.summaryHistoryRequestGeneration = requestGeneration;
  const agentId = normalizeOptionalString(state.summaryHistoryAgentId);
  const query = state.summaryHistoryQuery.trim();
  const request: SessionSummaryRequest = {
    generation: requestGeneration,
    client,
    agentId,
    query,
  };

  if (!methodIsAdvertised(state)) {
    markSummaryHistoryUnavailable(state);
    state.summaryHistoryLoading = false;
    state.summaryHistoryLoadingMore = false;
    return;
  }

  if (append) {
    state.summaryHistoryLoadingMore = true;
  } else {
    state.summaryHistoryLoading = true;
    state.summaryHistoryLoadingMore = false;
  }
  state.summaryHistoryError = null;
  state.summaryHistoryUnavailable = false;

  try {
    const payload = await client.request(SESSION_SUMMARIES_LIST_METHOD, {
      ...(agentId ? { agentId } : {}),
      ...(cursor ? { cursor } : {}),
      limit: SESSION_SUMMARIES_PAGE_SIZE,
      ...(query ? { query } : {}),
    });
    if (!isCurrentSummaryRequest(state, request)) {
      return;
    }
    const response = normalizeSummaryResponse(payload);
    state.summaryHistoryItems = append
      ? mergeSummaryPages(state.summaryHistoryItems, response.items)
      : response.items;
    state.summaryHistoryNextCursor = response.nextCursor ?? null;
  } catch (error) {
    if (!isCurrentSummaryRequest(state, request)) {
      return;
    }
    if (isUnknownMethodError(error)) {
      markSummaryHistoryUnavailable(state);
    } else {
      state.summaryHistoryError = error instanceof Error ? error.message : String(error);
    }
  } finally {
    if (isCurrentSummaryRequest(state, request)) {
      state.summaryHistoryLoading = false;
      state.summaryHistoryLoadingMore = false;
    }
  }
}
