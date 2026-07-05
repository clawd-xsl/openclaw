// Memory Core plugin module persists and pages session-summary records.
import { createHash } from "node:crypto";
import type {
  PluginStateKeyedStore,
  PluginStateEntry,
} from "openclaw/plugin-sdk/plugin-state-runtime";

export const SESSION_SUMMARY_PROMPT_VERSION = 1;
export const SESSION_SUMMARY_VERSION = 1;
export const SESSION_SUMMARY_LIST_HARD_LIMIT = 100;
export const SESSION_SUMMARY_TOOL_HARD_LIMIT = 20;
export const SESSION_SUMMARY_QUERY_MAX_CHARS = 512;
export const SESSION_SUMMARY_STORE_MAX_ENTRIES = 20_000;
export const SESSION_SUMMARY_MAX_ATTEMPTS = 5;
export const SESSION_SUMMARY_RETRY_BASE_MS = 30_000;
export const SESSION_SUMMARY_RETRY_MAX_MS = 6 * 60 * 60 * 1_000;
export const SESSION_SUMMARY_PROCESSING_LEASE_MS = 5 * 60 * 1_000;

export type SessionSummaryStatus = "pending" | "processing" | "complete" | "failed";

export type SessionSummaryRecord = {
  recordVersion: 1;
  agentId: string;
  sessionId: string;
  sessionKey: string;
  status: SessionSummaryStatus;
  promptVersion: number;
  summaryVersion: number;
  transcriptFingerprint: string | null;
  attemptCount: number;
  /** Internal optimistic-CAS generation. Never expose through tool/RPC records. */
  revision: number;
  /** Internal generation config identity used to invalidate stale work. */
  generationConfigFingerprint: string;
  lastError: string | null;
  /** Internal retry schedule. Never expose through tool/RPC records. */
  nextAttemptAt: number | null;
  nextSessionId: string | null;
  endedAt: number;
  messageCount: number;
  extractedMessageCount: number | null;
  model: string | null;
  generatedAt: number | null;
  summary: string | null;
  skipReason: "below_min_messages" | null;
  processingAt: number | null;
  /** Internal claim lease. Never expose through tool/RPC records. */
  leaseExpiresAt: number | null;
  updatedAt: number;
  // Transitional retry locator. It is never exposed by the tool or RPC.
  sessionFile: string | null;
  transcriptArchived: boolean;
};

export type SessionSummaryPublicRecord = Omit<
  SessionSummaryRecord,
  | "generationConfigFingerprint"
  | "leaseExpiresAt"
  | "nextAttemptAt"
  | "processingAt"
  | "recordVersion"
  | "revision"
  | "sessionFile"
  | "transcriptArchived"
  | "updatedAt"
>;

export type SessionSummaryEnqueueInput = {
  agentId: string;
  sessionId: string;
  sessionKey: string;
  nextSessionId?: string;
  endedAt: number;
  messageCount: number;
  generationConfigFingerprint?: string;
  sessionFile?: string;
  transcriptArchived?: boolean;
};

export type SessionSummaryPredecessorIndexRecord = {
  indexVersion: 1;
  agentId: string;
  currentSessionId: string;
  predecessorEndedAt: number | null;
  predecessorSessionId: string | null;
  summaryKey: string | null;
  updatedAt: number;
};

export type SessionSummaryListParams = {
  agentId: string;
  cursor?: string;
  limit?: number;
  lookbackDays: number;
  query?: string;
  statuses?: readonly SessionSummaryStatus[];
};

export type SessionSummaryListResult = {
  items: SessionSummaryPublicRecord[];
  nextCursor?: string;
};

type OpenStore = () => PluginStateKeyedStore<SessionSummaryRecord>;
type OpenPredecessorIndexStore = () => PluginStateKeyedStore<SessionSummaryPredecessorIndexRecord>;

type CursorPayload = {
  agentIdHash: string;
  endedAt: number;
  sessionIdHash: string;
  version: 1;
};

function normalizeAgentId(value: string): string {
  return value.trim().toLowerCase();
}

function normalizeString(value: string): string {
  return value.trim();
}

function isStatus(value: unknown): value is SessionSummaryStatus {
  return (
    value === "pending" || value === "processing" || value === "complete" || value === "failed"
  );
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isNullableFiniteNumber(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isFinite(value));
}

export function isSessionSummaryRecord(value: unknown): value is SessionSummaryRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Partial<SessionSummaryRecord>;
  return (
    record.recordVersion === 1 &&
    typeof record.agentId === "string" &&
    typeof record.sessionId === "string" &&
    typeof record.sessionKey === "string" &&
    isStatus(record.status) &&
    typeof record.endedAt === "number" &&
    Number.isFinite(record.endedAt) &&
    typeof record.messageCount === "number" &&
    Number.isFinite(record.messageCount) &&
    typeof record.attemptCount === "number" &&
    Number.isSafeInteger(record.attemptCount) &&
    record.attemptCount >= 0 &&
    typeof record.revision === "number" &&
    Number.isSafeInteger(record.revision) &&
    record.revision >= 1 &&
    typeof record.generationConfigFingerprint === "string" &&
    typeof record.promptVersion === "number" &&
    Number.isSafeInteger(record.promptVersion) &&
    typeof record.summaryVersion === "number" &&
    Number.isSafeInteger(record.summaryVersion) &&
    isNullableString(record.transcriptFingerprint) &&
    isNullableString(record.lastError) &&
    isNullableFiniteNumber(record.nextAttemptAt) &&
    isNullableString(record.nextSessionId) &&
    isNullableFiniteNumber(record.extractedMessageCount) &&
    isNullableString(record.model) &&
    isNullableFiniteNumber(record.generatedAt) &&
    isNullableString(record.summary) &&
    (record.skipReason === null || record.skipReason === "below_min_messages") &&
    isNullableFiniteNumber(record.processingAt) &&
    isNullableFiniteNumber(record.leaseExpiresAt) &&
    typeof record.updatedAt === "number" &&
    Number.isFinite(record.updatedAt) &&
    isNullableString(record.sessionFile) &&
    typeof record.transcriptArchived === "boolean"
  );
}

function isSessionSummaryPredecessorIndexRecord(
  value: unknown,
): value is SessionSummaryPredecessorIndexRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Partial<SessionSummaryPredecessorIndexRecord>;
  return (
    record.indexVersion === 1 &&
    typeof record.agentId === "string" &&
    typeof record.currentSessionId === "string" &&
    isNullableFiniteNumber(record.predecessorEndedAt) &&
    isNullableString(record.predecessorSessionId) &&
    isNullableString(record.summaryKey) &&
    typeof record.updatedAt === "number" &&
    Number.isFinite(record.updatedAt)
  );
}

export function buildSessionSummaryStoreKey(agentId: string, sessionId: string): string {
  const digest = createHash("sha256")
    .update(`${normalizeAgentId(agentId)}\u0000${normalizeString(sessionId)}`)
    .digest("hex");
  return `v1:${digest}`;
}

export function buildSessionSummaryPredecessorIndexKey(
  agentId: string,
  currentSessionId: string,
): string {
  const digest = createHash("sha256")
    .update(`${normalizeAgentId(agentId)}\u0000${normalizeString(currentSessionId)}`)
    .digest("hex");
  return `v1:${digest}`;
}

function computeRetryDelayMs(attemptCount: number): number {
  return Math.min(
    SESSION_SUMMARY_RETRY_MAX_MS,
    SESSION_SUMMARY_RETRY_BASE_MS * 2 ** Math.max(0, attemptCount - 1),
  );
}

function compareRecords(left: SessionSummaryRecord, right: SessionSummaryRecord): number {
  return right.endedAt - left.endedAt || left.sessionId.localeCompare(right.sessionId);
}

function toPublicRecord(record: SessionSummaryRecord): SessionSummaryPublicRecord {
  const {
    generationConfigFingerprint: _generationConfigFingerprint,
    leaseExpiresAt: _leaseExpiresAt,
    nextAttemptAt: _nextAttemptAt,
    processingAt: _processingAt,
    recordVersion: _recordVersion,
    revision: _revision,
    sessionFile: _sessionFile,
    transcriptArchived: _transcriptArchived,
    updatedAt: _updatedAt,
    ...publicRecord
  } = record;
  return publicRecord;
}

export function encodeSessionSummaryCursor(
  record: Pick<SessionSummaryRecord, "agentId" | "endedAt" | "sessionId">,
): string {
  const payload: CursorPayload = {
    agentIdHash: createHash("sha256").update(normalizeAgentId(record.agentId)).digest("base64url"),
    endedAt: record.endedAt,
    sessionIdHash: createHash("sha256").update(record.sessionId).digest("base64url"),
    version: 1,
  };
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function decodeCursor(cursor: string): CursorPayload {
  if (!cursor || cursor.length > 2_048) {
    throw new Error("invalid session summaries cursor");
  }
  try {
    const value = JSON.parse(
      Buffer.from(cursor, "base64url").toString("utf8"),
    ) as Partial<CursorPayload>;
    if (
      value.version !== 1 ||
      typeof value.agentIdHash !== "string" ||
      !/^[A-Za-z0-9_-]{43}$/u.test(value.agentIdHash) ||
      typeof value.endedAt !== "number" ||
      !Number.isFinite(value.endedAt) ||
      typeof value.sessionIdHash !== "string" ||
      !/^[A-Za-z0-9_-]{43}$/u.test(value.sessionIdHash)
    ) {
      throw new Error("invalid cursor payload");
    }
    return {
      agentIdHash: value.agentIdHash,
      endedAt: value.endedAt,
      sessionIdHash: value.sessionIdHash,
      version: 1,
    };
  } catch {
    throw new Error("invalid session summaries cursor");
  }
}

function normalizeLiteralQuery(query: string | undefined): string | undefined {
  const normalized = query?.trim();
  if (!normalized) {
    return undefined;
  }
  if (normalized.length > SESSION_SUMMARY_QUERY_MAX_CHARS) {
    throw new Error(
      `session summaries query must be at most ${SESSION_SUMMARY_QUERY_MAX_CHARS} characters`,
    );
  }
  return normalized.toLowerCase();
}

function literalMatches(
  record: SessionSummaryRecord,
  normalizedQuery: string | undefined,
): boolean {
  if (!normalizedQuery) {
    return true;
  }
  return [record.summary, record.sessionKey, record.sessionId, record.lastError]
    .filter((value): value is string => typeof value === "string")
    .some((value) => value.toLowerCase().includes(normalizedQuery));
}

function normalizeLimit(limit: number | undefined, hardLimit: number): number {
  if (!Number.isSafeInteger(limit) || (limit ?? 0) < 1) {
    return Math.min(25, hardLimit);
  }
  return Math.min(limit as number, hardLimit);
}

export function paginateSessionSummaryRecords(params: {
  agentId: string;
  cursor?: string;
  hardLimit?: number;
  limit?: number;
  records: readonly SessionSummaryRecord[];
}): SessionSummaryListResult {
  const agentId = normalizeAgentId(params.agentId);
  const hardLimit = Math.max(
    1,
    Math.min(params.hardLimit ?? SESSION_SUMMARY_LIST_HARD_LIMIT, SESSION_SUMMARY_LIST_HARD_LIMIT),
  );
  const limit = normalizeLimit(params.limit, hardLimit);
  const records = params.records.toSorted(compareRecords);
  let start = 0;
  if (params.cursor) {
    const cursor = decodeCursor(params.cursor);
    const agentIdHash = createHash("sha256").update(agentId).digest("base64url");
    if (cursor.agentIdHash !== agentIdHash) {
      throw new Error("session summaries cursor belongs to another agent");
    }
    const index = records.findIndex(
      (record) =>
        record.endedAt === cursor.endedAt &&
        createHash("sha256").update(record.sessionId).digest("base64url") === cursor.sessionIdHash,
    );
    if (index < 0) {
      throw new Error("session summaries cursor is stale or invalid");
    }
    start = index + 1;
  }
  const page = records.slice(start, start + limit);
  const hasMore = start + page.length < records.length;
  const last = page.at(-1);
  return {
    items: page.map(toPublicRecord),
    ...(hasMore && last ? { nextCursor: encodeSessionSummaryCursor(last) } : {}),
  };
}

export class SessionSummaryRepository {
  private store: PluginStateKeyedStore<SessionSummaryRecord> | undefined;
  private predecessorIndexStore:
    | PluginStateKeyedStore<SessionSummaryPredecessorIndexRecord>
    | undefined;
  private readonly openStore: OpenStore;
  private readonly openPredecessorIndexStore: OpenPredecessorIndexStore;
  private readonly now: () => number;

  constructor(deps: {
    now?: () => number;
    openPredecessorIndexStore: OpenPredecessorIndexStore;
    openStore: OpenStore;
  }) {
    this.openStore = deps.openStore;
    this.openPredecessorIndexStore = deps.openPredecessorIndexStore;
    this.now = deps.now ?? Date.now;
  }

  private getStore(): PluginStateKeyedStore<SessionSummaryRecord> {
    this.store ??= this.openStore();
    return this.store;
  }

  private getPredecessorIndexStore(): PluginStateKeyedStore<SessionSummaryPredecessorIndexRecord> {
    this.predecessorIndexStore ??= this.openPredecessorIndexStore();
    return this.predecessorIndexStore;
  }

  private async updateRecord(
    key: string,
    updater: (current: SessionSummaryRecord | undefined) => SessionSummaryRecord | undefined,
  ): Promise<SessionSummaryRecord | undefined> {
    const store = this.getStore();
    if (!store.update) {
      throw new Error("plugin state store does not support atomic updates");
    }
    let next: SessionSummaryRecord | undefined;
    await store.update(key, (current) => {
      next = updater(isSessionSummaryRecord(current) ? current : undefined);
      return next;
    });
    return next;
  }

  private async writePredecessorIndex(key: string, record: SessionSummaryRecord): Promise<void> {
    const currentSessionId = record.nextSessionId;
    if (!currentSessionId) {
      return;
    }
    const store = this.getPredecessorIndexStore();
    if (!store.update) {
      throw new Error("plugin state predecessor index does not support atomic updates");
    }
    const indexKey = buildSessionSummaryPredecessorIndexKey(record.agentId, currentSessionId);
    await store.update(indexKey, (value) => {
      const current = isSessionSummaryPredecessorIndexRecord(value) ? value : undefined;
      const currentWinsTie =
        current?.predecessorEndedAt === record.endedAt &&
        (current.predecessorSessionId ?? "").localeCompare(record.sessionId) <= 0;
      if (
        current?.summaryKey &&
        current.summaryKey !== key &&
        ((current.predecessorEndedAt ?? Number.NEGATIVE_INFINITY) > record.endedAt ||
          currentWinsTie)
      ) {
        return undefined;
      }
      return {
        indexVersion: 1,
        agentId: record.agentId,
        currentSessionId,
        predecessorEndedAt: record.endedAt,
        predecessorSessionId: record.sessionId,
        summaryKey: key,
        updatedAt: this.now(),
      };
    });
  }

  private async clearPredecessorIndex(params: {
    agentId: string;
    currentSessionId: string;
    predecessorSessionId: string;
    summaryKey: string;
  }): Promise<void> {
    const store = this.getPredecessorIndexStore();
    if (!store.update) {
      throw new Error("plugin state predecessor index does not support atomic updates");
    }
    const indexKey = buildSessionSummaryPredecessorIndexKey(
      params.agentId,
      params.currentSessionId,
    );
    await store.update(indexKey, (value) => {
      const current = isSessionSummaryPredecessorIndexRecord(value) ? value : undefined;
      if (
        !current ||
        current.summaryKey !== params.summaryKey ||
        current.predecessorSessionId !== params.predecessorSessionId
      ) {
        return undefined;
      }
      // The public store cannot conditionally delete. A conditional tombstone avoids
      // deleting a newer pointer that raced this cleanup.
      return {
        ...current,
        predecessorEndedAt: null,
        predecessorSessionId: null,
        summaryKey: null,
        updatedAt: this.now(),
      };
    });
  }

  async enqueue(input: SessionSummaryEnqueueInput): Promise<{
    key: string;
    record: SessionSummaryRecord;
    shouldProcess: boolean;
  }> {
    const agentId = normalizeAgentId(input.agentId);
    const sessionId = normalizeString(input.sessionId);
    const sessionKey = normalizeString(input.sessionKey);
    if (!agentId || !sessionId || !sessionKey) {
      throw new Error("session summary enqueue requires agentId, sessionId, and sessionKey");
    }
    const now = this.now();
    const endedAt = Number.isFinite(input.endedAt) ? input.endedAt : now;
    const messageCount = Number.isSafeInteger(input.messageCount)
      ? Math.max(0, input.messageCount)
      : 0;
    const generationConfigFingerprint = input.generationConfigFingerprint?.trim() || "default";
    const key = buildSessionSummaryStoreKey(agentId, sessionId);
    const initial: SessionSummaryRecord = {
      recordVersion: 1,
      agentId,
      sessionId,
      sessionKey,
      status: "pending",
      promptVersion: SESSION_SUMMARY_PROMPT_VERSION,
      summaryVersion: SESSION_SUMMARY_VERSION,
      transcriptFingerprint: null,
      attemptCount: 0,
      revision: 1,
      generationConfigFingerprint,
      lastError: null,
      nextAttemptAt: null,
      nextSessionId: input.nextSessionId?.trim() || null,
      endedAt,
      messageCount,
      extractedMessageCount: null,
      model: null,
      generatedAt: null,
      summary: null,
      skipReason: null,
      processingAt: null,
      leaseExpiresAt: null,
      updatedAt: now,
      sessionFile: input.sessionFile?.trim() || null,
      transcriptArchived: input.transcriptArchived === true,
    };
    const inserted = await this.getStore().registerIfAbsent(key, initial);
    if (inserted) {
      await this.writePredecessorIndex(key, initial);
      return { key, record: initial, shouldProcess: true };
    }

    let shouldProcess = false;
    let previousNextSessionId: string | null = null;
    const record = await this.updateRecord(key, (current) => {
      if (!current) {
        shouldProcess = true;
        return initial;
      }
      previousNextSessionId = current.nextSessionId;
      const versionChanged =
        current.promptVersion !== SESSION_SUMMARY_PROMPT_VERSION ||
        current.summaryVersion !== SESSION_SUMMARY_VERSION;
      const configChanged = current.generationConfigFingerprint !== generationConfigFingerprint;
      const contentGrew = messageCount > current.messageCount;
      const invalidate =
        versionChanged || configChanged || (contentGrew && current.status !== "pending");
      const status = invalidate ? "pending" : current.status;
      const failedRetryDue =
        status === "failed" &&
        current.attemptCount < SESSION_SUMMARY_MAX_ATTEMPTS &&
        current.nextAttemptAt !== null &&
        current.nextAttemptAt <= now;
      const processingLeaseExpired =
        status === "processing" && current.leaseExpiresAt !== null && current.leaseExpiresAt <= now;
      shouldProcess = status === "pending" || failedRetryDue || processingLeaseExpired;
      return {
        ...current,
        sessionKey,
        status,
        promptVersion: SESSION_SUMMARY_PROMPT_VERSION,
        summaryVersion: SESSION_SUMMARY_VERSION,
        generationConfigFingerprint,
        nextSessionId: input.nextSessionId?.trim() || current.nextSessionId,
        endedAt: Math.max(current.endedAt, endedAt),
        messageCount: Math.max(current.messageCount, messageCount),
        sessionFile: input.sessionFile?.trim() || current.sessionFile,
        transcriptArchived: current.transcriptArchived || input.transcriptArchived === true,
        ...(invalidate
          ? {
              attemptCount: 0,
              revision: current.revision + 1,
              transcriptFingerprint: null,
              extractedMessageCount: null,
              model: null,
              generatedAt: null,
              summary: null,
              skipReason: null,
              nextAttemptAt: null,
            }
          : {}),
        ...(invalidate
          ? {
              lastError: null,
              processingAt: null,
              leaseExpiresAt: null,
            }
          : {}),
        updatedAt: now,
      };
    });
    if (!record) {
      throw new Error("session summary state disappeared during enqueue");
    }
    if (previousNextSessionId && previousNextSessionId !== record.nextSessionId) {
      await this.clearPredecessorIndex({
        agentId,
        currentSessionId: previousNextSessionId,
        predecessorSessionId: sessionId,
        summaryKey: key,
      });
    }
    await this.writePredecessorIndex(key, record);
    return { key, record, shouldProcess };
  }

  async claim(key: string): Promise<SessionSummaryRecord | undefined> {
    const now = this.now();
    let claimed = false;
    const record = await this.updateRecord(key, (current) => {
      if (!current) {
        return undefined;
      }
      const eligiblePending = current.status === "pending";
      const eligibleFailed =
        current.status === "failed" &&
        current.nextAttemptAt !== null &&
        current.nextAttemptAt <= now;
      const eligibleExpiredProcessing =
        current.status === "processing" &&
        (current.leaseExpiresAt ?? current.processingAt ?? 0) <= now;
      if (!eligiblePending && !eligibleFailed && !eligibleExpiredProcessing) {
        return undefined;
      }
      if (current.attemptCount >= SESSION_SUMMARY_MAX_ATTEMPTS) {
        return {
          ...current,
          status: "failed",
          revision: current.revision + 1,
          lastError: current.lastError ?? "session summary retry limit reached",
          nextAttemptAt: null,
          processingAt: null,
          leaseExpiresAt: null,
          updatedAt: now,
        };
      }
      claimed = true;
      return {
        ...current,
        status: "processing",
        attemptCount: current.attemptCount + 1,
        revision: current.revision + 1,
        lastError: null,
        nextAttemptAt: null,
        processingAt: now,
        leaseExpiresAt: now + SESSION_SUMMARY_PROCESSING_LEASE_MS,
        updatedAt: now,
      };
    });
    return claimed ? record : undefined;
  }

  async releaseClaim(
    key: string,
    expectedRevision: number,
  ): Promise<SessionSummaryRecord | undefined> {
    const now = this.now();
    let released = false;
    const record = await this.updateRecord(key, (current) => {
      if (!current || current.status !== "processing" || current.revision !== expectedRevision) {
        return undefined;
      }
      released = true;
      return {
        ...current,
        status: "pending",
        attemptCount: Math.max(0, current.attemptCount - 1),
        revision: current.revision + 1,
        lastError: null,
        nextAttemptAt: null,
        processingAt: null,
        leaseExpiresAt: null,
        updatedAt: now,
      };
    });
    return released ? record : undefined;
  }

  async markComplete(
    key: string,
    result: {
      extractedMessageCount: number;
      expectedRevision: number;
      fingerprint: string;
      generatedAt: number;
      model: string | null;
      skipReason?: "below_min_messages";
      summary: string;
    },
  ): Promise<SessionSummaryRecord | undefined> {
    let committed = false;
    const record = await this.updateRecord(key, (current) => {
      if (
        !current ||
        current.status !== "processing" ||
        current.revision !== result.expectedRevision
      ) {
        return undefined;
      }
      committed = true;
      return {
        ...current,
        status: "complete",
        transcriptFingerprint: result.fingerprint,
        extractedMessageCount: result.extractedMessageCount,
        model: result.model,
        generatedAt: result.generatedAt,
        summary: result.summary,
        skipReason: result.skipReason ?? null,
        lastError: null,
        nextAttemptAt: null,
        processingAt: null,
        leaseExpiresAt: null,
        updatedAt: result.generatedAt,
      };
    });
    if (!committed || !record) {
      return undefined;
    }
    await this.writePredecessorIndex(key, record);
    return record;
  }

  async markFailed(
    key: string,
    error: string,
    now: number,
    expectedRevision: number,
  ): Promise<SessionSummaryRecord | undefined> {
    let committed = false;
    const record = await this.updateRecord(key, (current) => {
      if (!current || current.status !== "processing" || current.revision !== expectedRevision) {
        return undefined;
      }
      committed = true;
      const exhausted = current.attemptCount >= SESSION_SUMMARY_MAX_ATTEMPTS;
      return {
        ...current,
        status: "failed",
        lastError: error,
        nextAttemptAt: exhausted ? null : now + computeRetryDelayMs(current.attemptCount),
        processingAt: null,
        leaseExpiresAt: null,
        updatedAt: now,
      };
    });
    return committed ? record : undefined;
  }

  async purge(agentId: string, sessionId: string): Promise<{ key: string; deleted: boolean }> {
    const normalizedAgentId = normalizeAgentId(agentId);
    const normalizedSessionId = normalizeString(sessionId);
    const key = buildSessionSummaryStoreKey(normalizedAgentId, normalizedSessionId);
    const value = await this.getStore().lookup(key);
    const record = isSessionSummaryRecord(value) ? value : undefined;
    const deleted = await this.getStore().delete(key);
    if (record?.nextSessionId) {
      await this.clearPredecessorIndex({
        agentId: record.agentId,
        currentSessionId: record.nextSessionId,
        predecessorSessionId: record.sessionId,
        summaryKey: key,
      });
    }
    return { key, deleted };
  }

  async readAllRecords(): Promise<SessionSummaryRecord[]> {
    const entries: PluginStateEntry<SessionSummaryRecord>[] = await this.getStore().entries();
    return entries.map((entry) => entry.value).filter(isSessionSummaryRecord);
  }

  async queryRecords(
    params: Omit<SessionSummaryListParams, "cursor" | "limit">,
  ): Promise<SessionSummaryRecord[]> {
    const agentId = normalizeAgentId(params.agentId);
    const cutoff = this.now() - params.lookbackDays * 86_400_000;
    const statuses = params.statuses ? new Set(params.statuses) : undefined;
    const query = normalizeLiteralQuery(params.query);
    return (await this.readAllRecords())
      .filter(
        (record) =>
          record.agentId === agentId &&
          record.endedAt >= cutoff &&
          (!statuses || statuses.has(record.status)) &&
          literalMatches(record, query),
      )
      .toSorted(compareRecords);
  }

  async list(params: SessionSummaryListParams): Promise<SessionSummaryListResult> {
    const records = await this.queryRecords(params);
    return paginateSessionSummaryRecords({
      agentId: params.agentId,
      records,
      ...(params.cursor ? { cursor: params.cursor } : {}),
      ...(params.limit !== undefined ? { limit: params.limit } : {}),
    });
  }

  async listRecoverable(
    lookbackDays: number,
  ): Promise<Array<{ key: string; record: SessionSummaryRecord }>> {
    const cutoff = this.now() - lookbackDays * 86_400_000;
    const entries = await this.getStore().entries();
    return entries
      .filter(
        (entry): entry is PluginStateEntry<SessionSummaryRecord> =>
          isSessionSummaryRecord(entry.value) &&
          entry.value.endedAt >= cutoff &&
          (entry.value.status === "pending" ||
            (entry.value.status === "failed" &&
              entry.value.attemptCount < SESSION_SUMMARY_MAX_ATTEMPTS &&
              entry.value.nextAttemptAt !== null) ||
            entry.value.status === "processing"),
      )
      .map((entry) => ({ key: entry.key, record: entry.value }));
  }

  async findDirectPredecessor(params: {
    agentId: string;
    currentSessionId: string;
    lookbackDays: number;
  }): Promise<SessionSummaryRecord | undefined> {
    const agentId = normalizeAgentId(params.agentId);
    const currentSessionId = normalizeString(params.currentSessionId);
    const indexValue = await this.getPredecessorIndexStore().lookup(
      buildSessionSummaryPredecessorIndexKey(agentId, currentSessionId),
    );
    const indexRecord = isSessionSummaryPredecessorIndexRecord(indexValue) ? indexValue : undefined;
    if (
      !indexRecord?.summaryKey ||
      !indexRecord.predecessorSessionId ||
      indexRecord.agentId !== agentId ||
      indexRecord.currentSessionId !== currentSessionId
    ) {
      return undefined;
    }
    const value = await this.getStore().lookup(indexRecord.summaryKey);
    const record = isSessionSummaryRecord(value) ? value : undefined;
    const cutoff = this.now() - params.lookbackDays * 86_400_000;
    if (
      !record ||
      record.agentId !== agentId ||
      record.sessionId !== indexRecord.predecessorSessionId ||
      record.endedAt !== indexRecord.predecessorEndedAt ||
      record.nextSessionId !== currentSessionId ||
      record.endedAt < cutoff
    ) {
      return undefined;
    }
    return record;
  }
}
