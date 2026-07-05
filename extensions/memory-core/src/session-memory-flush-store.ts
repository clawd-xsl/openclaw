// Memory Core plugin module persists the completed-session memory-flush outbox.
import { createHash } from "node:crypto";
import path from "node:path";
import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";

export const SESSION_MEMORY_FLUSH_RECORD_VERSION = 1;
// Recovery enumerates this namespace at startup, so keep the durable outbox capped.
export const SESSION_MEMORY_FLUSH_STORE_MAX_ENTRIES = 4_096;
export const SESSION_MEMORY_FLUSH_MAX_ATTEMPTS = 5;
export const SESSION_MEMORY_FLUSH_RETRY_BASE_MS = 30_000;
export const SESSION_MEMORY_FLUSH_RETRY_MAX_MS = 6 * 60 * 60 * 1_000;
export const SESSION_MEMORY_FLUSH_PROCESSING_LEASE_MS = 45 * 60 * 1_000;
export const SESSION_MEMORY_FLUSH_PLAN_TEXT_MAX_BYTES = 8 * 1024;
export const SESSION_MEMORY_FLUSH_CANDIDATE_JSON_MAX_BYTES = 24 * 1024;
export const SESSION_MEMORY_FLUSH_RECORD_MAX_BYTES = 64 * 1024;
export const SESSION_MEMORY_FLUSH_WORKSPACE_PATH_MAX_BYTES = 8 * 1024;

export type SessionMemoryFlushStatus = "pending" | "processing" | "failed" | "complete";
export type SessionMemoryFlushTerminalCode =
  | "cancelled"
  | "marker_hash_conflict"
  | "partial_marker";

export type SessionMemoryFlushPlanSnapshot = {
  fingerprint: string;
  model: string | null;
  prompt: string;
  relativePath: string;
  systemPrompt: string;
};

export type SessionMemoryFlushCandidate =
  | { kind: "append"; content: string; sha256: string }
  | { kind: "noop"; sha256: string };

export type SessionMemoryFlushWorkspaceTarget = {
  configuredPath: string;
  device: string;
  fingerprint: string;
  inode: string;
  realPath: string;
};

export type SessionMemoryFlushRecord = {
  recordVersion: 1;
  operationId: string;
  agentId: string;
  sessionId: string;
  sessionKey: string;
  status: SessionMemoryFlushStatus;
  revision: number;
  attemptCount: number;
  endedAt: number;
  messageCount: number;
  maxPromptTokens: number;
  generationConfigFingerprint: string;
  plan: SessionMemoryFlushPlanSnapshot;
  workspaceTarget: SessionMemoryFlushWorkspaceTarget;
  candidate: SessionMemoryFlushCandidate | null;
  transcriptFingerprint: string | null;
  extractedMessageCount: number | null;
  processingAt: number | null;
  leaseExpiresAt: number | null;
  nextAttemptAt: number | null;
  lastError: string | null;
  terminalCode: SessionMemoryFlushTerminalCode | null;
  projectedAt: number | null;
  completedAt: number | null;
  updatedAt: number;
  sessionFile: string | null;
  transcriptArchived: boolean;
};

export type SessionMemoryFlushEnqueueInput = {
  agentId: string;
  sessionId: string;
  sessionKey: string;
  endedAt: number;
  messageCount: number;
  maxPromptTokens: number;
  plan: SessionMemoryFlushPlanSnapshot;
  workspaceTarget: SessionMemoryFlushWorkspaceTarget;
  generationConfigFingerprint: string;
  sessionFile?: string;
  transcriptArchived?: boolean;
};

type OpenStore = () => PluginStateKeyedStore<SessionMemoryFlushRecord>;

function normalizeAgentId(value: string): string {
  return value.trim().toLowerCase();
}

function normalizeString(value: string): string {
  return value.trim();
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function jsonStringBytes(value: string): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function truncateJsonStringBytes(value: string, maxBytes: number): string {
  if (jsonStringBytes(value) <= maxBytes) {
    return value;
  }
  let low = 0;
  let high = value.length;
  let best = "";
  while (low <= high) {
    const midpoint = Math.floor((low + high) / 2);
    let candidate = value.slice(0, midpoint);
    const lastCodeUnit = candidate.charCodeAt(candidate.length - 1);
    if (lastCodeUnit >= 0xd800 && lastCodeUnit <= 0xdbff) {
      candidate = candidate.slice(0, -1);
    }
    if (jsonStringBytes(candidate) <= maxBytes) {
      best = candidate;
      low = midpoint + 1;
    } else {
      high = midpoint - 1;
    }
  }
  return best;
}

export function isCanonicalSessionMemoryFlushPath(value: string): boolean {
  const match = /^memory\/(\d{4}-\d{2}-\d{2})\.md$/u.exec(value);
  if (!match?.[1]) {
    return false;
  }
  const timestamp = Date.parse(`${match[1]}T00:00:00.000Z`);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === match[1];
}

function planFingerprint(value: {
  model: string | null;
  prompt: string;
  relativePath: string;
  systemPrompt: string;
}): string {
  return sha256(JSON.stringify(value));
}

function workspaceTargetFingerprint(value: {
  configuredPath: string;
  device: string;
  inode: string;
  realPath: string;
}): string {
  return sha256(JSON.stringify(value));
}

function recordByteLength(record: SessionMemoryFlushRecord): number {
  return Buffer.byteLength(JSON.stringify(record), "utf8");
}

function isRecordWithinSizeLimit(record: SessionMemoryFlushRecord): boolean {
  try {
    return recordByteLength(record) < SESSION_MEMORY_FLUSH_RECORD_MAX_BYTES;
  } catch {
    return false;
  }
}

function assertRecordSize(record: SessionMemoryFlushRecord): SessionMemoryFlushRecord {
  const bytes = recordByteLength(record);
  if (bytes >= SESSION_MEMORY_FLUSH_RECORD_MAX_BYTES) {
    throw new Error(
      `session memory flush record exceeds ${SESSION_MEMORY_FLUSH_RECORD_MAX_BYTES} bytes`,
    );
  }
  return record;
}

export function buildSessionMemoryFlushOperationId(agentId: string, sessionId: string): string {
  return `v1:${sha256(`${normalizeAgentId(agentId)}\u0000${normalizeString(sessionId)}`)}`;
}

export function createSessionMemoryFlushPlanSnapshot(params: {
  model?: string;
  prompt: string;
  relativePath: string;
  systemPrompt: string;
}): SessionMemoryFlushPlanSnapshot {
  if (!isCanonicalSessionMemoryFlushPath(params.relativePath)) {
    throw new Error("session memory flush path must be canonical memory/YYYY-MM-DD.md");
  }
  const value = {
    model: params.model?.trim().slice(0, 256) || null,
    prompt: truncateJsonStringBytes(params.prompt, SESSION_MEMORY_FLUSH_PLAN_TEXT_MAX_BYTES),
    relativePath: params.relativePath,
    systemPrompt: truncateJsonStringBytes(
      params.systemPrompt,
      SESSION_MEMORY_FLUSH_PLAN_TEXT_MAX_BYTES,
    ),
  };
  return { ...value, fingerprint: planFingerprint(value) };
}

function isBoundedAbsolutePath(value: string): boolean {
  return (
    path.isAbsolute(value) &&
    path.resolve(value) === value &&
    !value.includes("\u0000") &&
    Buffer.byteLength(value, "utf8") <= SESSION_MEMORY_FLUSH_WORKSPACE_PATH_MAX_BYTES
  );
}

export function createSessionMemoryFlushWorkspaceTarget(params: {
  configuredPath: string;
  device: string;
  inode: string;
  realPath: string;
}): SessionMemoryFlushWorkspaceTarget {
  const value = {
    configuredPath: params.configuredPath,
    device: params.device,
    inode: params.inode,
    realPath: params.realPath,
  };
  if (
    !isBoundedAbsolutePath(value.configuredPath) ||
    !isBoundedAbsolutePath(value.realPath) ||
    !/^\d{1,32}$/u.test(value.device) ||
    !/^\d{1,32}$/u.test(value.inode)
  ) {
    throw new Error("session memory flush workspace target is invalid");
  }
  return { ...value, fingerprint: workspaceTargetFingerprint(value) };
}

export function createSessionMemoryFlushCandidate(
  candidate: { kind: "append"; content: string } | { kind: "noop" },
): SessionMemoryFlushCandidate {
  if (candidate.kind === "noop") {
    return { kind: "noop", sha256: sha256("noop") };
  }
  if (jsonStringBytes(candidate.content) > SESSION_MEMORY_FLUSH_CANDIDATE_JSON_MAX_BYTES) {
    throw new Error(
      `session memory flush candidate exceeds ${SESSION_MEMORY_FLUSH_CANDIDATE_JSON_MAX_BYTES} persisted bytes`,
    );
  }
  return { kind: "append", content: candidate.content, sha256: sha256(candidate.content) };
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isNullableNumber(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isFinite(value));
}

function isPlan(value: unknown): value is SessionMemoryFlushPlanSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const plan = value as Partial<SessionMemoryFlushPlanSnapshot>;
  if (
    typeof plan.fingerprint === "string" &&
    isNullableString(plan.model) &&
    typeof plan.prompt === "string" &&
    typeof plan.relativePath === "string" &&
    typeof plan.systemPrompt === "string"
  ) {
    const identity = {
      model: plan.model,
      prompt: plan.prompt,
      relativePath: plan.relativePath,
      systemPrompt: plan.systemPrompt,
    };
    return (
      isCanonicalSessionMemoryFlushPath(plan.relativePath) &&
      (plan.model === null || plan.model.length <= 256) &&
      jsonStringBytes(plan.prompt) <= SESSION_MEMORY_FLUSH_PLAN_TEXT_MAX_BYTES &&
      jsonStringBytes(plan.systemPrompt) <= SESSION_MEMORY_FLUSH_PLAN_TEXT_MAX_BYTES &&
      plan.fingerprint === planFingerprint(identity)
    );
  }
  return false;
}

function isCandidate(value: unknown): value is SessionMemoryFlushCandidate | null {
  if (value === null) {
    return true;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Partial<SessionMemoryFlushCandidate>;
  if (candidate.kind === "noop" && !("content" in candidate)) {
    return candidate.sha256 === sha256("noop");
  }
  return (
    candidate.kind === "append" &&
    typeof candidate.content === "string" &&
    candidate.sha256 === sha256(candidate.content) &&
    jsonStringBytes(candidate.content) <= SESSION_MEMORY_FLUSH_CANDIDATE_JSON_MAX_BYTES
  );
}

function isWorkspaceTarget(value: unknown): value is SessionMemoryFlushWorkspaceTarget {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const target = value as Partial<SessionMemoryFlushWorkspaceTarget>;
  if (
    typeof target.configuredPath !== "string" ||
    typeof target.device !== "string" ||
    typeof target.fingerprint !== "string" ||
    typeof target.inode !== "string" ||
    typeof target.realPath !== "string"
  ) {
    return false;
  }
  const identity = {
    configuredPath: target.configuredPath,
    device: target.device,
    inode: target.inode,
    realPath: target.realPath,
  };
  return (
    isBoundedAbsolutePath(target.configuredPath) &&
    isBoundedAbsolutePath(target.realPath) &&
    /^\d{1,32}$/u.test(target.device) &&
    /^\d{1,32}$/u.test(target.inode) &&
    target.fingerprint === workspaceTargetFingerprint(identity)
  );
}

export function isSessionMemoryFlushRecord(value: unknown): value is SessionMemoryFlushRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Partial<SessionMemoryFlushRecord>;
  if (
    record.recordVersion === SESSION_MEMORY_FLUSH_RECORD_VERSION &&
    typeof record.operationId === "string" &&
    typeof record.agentId === "string" &&
    typeof record.sessionId === "string" &&
    typeof record.sessionKey === "string" &&
    (record.status === "pending" ||
      record.status === "processing" ||
      record.status === "failed" ||
      record.status === "complete") &&
    typeof record.revision === "number" &&
    Number.isSafeInteger(record.revision) &&
    record.revision >= 1 &&
    typeof record.attemptCount === "number" &&
    Number.isSafeInteger(record.attemptCount) &&
    record.attemptCount >= 0 &&
    typeof record.endedAt === "number" &&
    Number.isFinite(record.endedAt) &&
    typeof record.messageCount === "number" &&
    Number.isSafeInteger(record.messageCount) &&
    typeof record.maxPromptTokens === "number" &&
    Number.isSafeInteger(record.maxPromptTokens) &&
    typeof record.generationConfigFingerprint === "string" &&
    isPlan(record.plan) &&
    isWorkspaceTarget(record.workspaceTarget) &&
    isCandidate(record.candidate) &&
    isNullableString(record.transcriptFingerprint) &&
    isNullableNumber(record.extractedMessageCount) &&
    isNullableNumber(record.processingAt) &&
    isNullableNumber(record.leaseExpiresAt) &&
    isNullableNumber(record.nextAttemptAt) &&
    isNullableString(record.lastError) &&
    (record.terminalCode === null ||
      record.terminalCode === "cancelled" ||
      record.terminalCode === "marker_hash_conflict" ||
      record.terminalCode === "partial_marker") &&
    isNullableNumber(record.projectedAt) &&
    isNullableNumber(record.completedAt) &&
    typeof record.updatedAt === "number" &&
    Number.isFinite(record.updatedAt) &&
    isNullableString(record.sessionFile) &&
    typeof record.transcriptArchived === "boolean"
  ) {
    return (
      /^v1:[a-f0-9]{64}$/u.test(record.operationId) &&
      record.operationId === buildSessionMemoryFlushOperationId(record.agentId, record.sessionId) &&
      isRecordWithinSizeLimit(record as SessionMemoryFlushRecord)
    );
  }
  return false;
}

function retryDelayMs(attemptCount: number): number {
  return Math.min(
    SESSION_MEMORY_FLUSH_RETRY_MAX_MS,
    SESSION_MEMORY_FLUSH_RETRY_BASE_MS * 2 ** Math.max(0, attemptCount - 1),
  );
}

export class SessionMemoryFlushRepository {
  private readonly now: () => number;
  private readonly openStore: OpenStore;
  private store: PluginStateKeyedStore<SessionMemoryFlushRecord> | undefined;

  constructor(deps: { now?: () => number; openStore: OpenStore }) {
    this.now = deps.now ?? Date.now;
    this.openStore = deps.openStore;
  }

  private getStore(): PluginStateKeyedStore<SessionMemoryFlushRecord> {
    this.store ??= this.openStore();
    return this.store;
  }

  private async updateRecord(
    key: string,
    updater: (
      current: SessionMemoryFlushRecord | undefined,
    ) => SessionMemoryFlushRecord | undefined,
  ): Promise<SessionMemoryFlushRecord | undefined> {
    const store = this.getStore();
    if (!store.update) {
      throw new Error("plugin state store does not support atomic updates");
    }
    let next: SessionMemoryFlushRecord | undefined;
    await store.update(key, (value) => {
      if (value !== undefined && !isSessionMemoryFlushRecord(value)) {
        throw new Error(`session memory flush record ${key} failed integrity validation`);
      }
      next = updater(value);
      return next ? assertRecordSize(next) : undefined;
    });
    return next;
  }

  async enqueue(input: SessionMemoryFlushEnqueueInput): Promise<{
    key: string;
    record: SessionMemoryFlushRecord;
    shouldProcess: boolean;
  }> {
    const agentId = normalizeAgentId(input.agentId);
    const sessionId = normalizeString(input.sessionId);
    const sessionKey = normalizeString(input.sessionKey);
    if (!agentId || !sessionId || !sessionKey) {
      throw new Error("session memory flush enqueue requires agentId, sessionId, and sessionKey");
    }
    const now = this.now();
    const key = buildSessionMemoryFlushOperationId(agentId, sessionId);
    const initial: SessionMemoryFlushRecord = {
      recordVersion: 1,
      operationId: key,
      agentId,
      sessionId,
      sessionKey,
      status: "pending",
      revision: 1,
      attemptCount: 0,
      endedAt: Number.isFinite(input.endedAt) ? input.endedAt : now,
      messageCount: Number.isSafeInteger(input.messageCount) ? Math.max(0, input.messageCount) : 0,
      maxPromptTokens: input.maxPromptTokens,
      generationConfigFingerprint: input.generationConfigFingerprint,
      plan: input.plan,
      workspaceTarget: input.workspaceTarget,
      candidate: null,
      transcriptFingerprint: null,
      extractedMessageCount: null,
      processingAt: null,
      leaseExpiresAt: null,
      nextAttemptAt: null,
      lastError: null,
      terminalCode: null,
      projectedAt: null,
      completedAt: null,
      updatedAt: now,
      sessionFile: input.sessionFile?.trim() || null,
      transcriptArchived: input.transcriptArchived === true,
    };
    if (!isSessionMemoryFlushRecord(initial)) {
      throw new Error("session memory flush enqueue input failed integrity validation");
    }
    assertRecordSize(initial);
    if (await this.getStore().registerIfAbsent(key, initial)) {
      return { key, record: initial, shouldProcess: true };
    }

    let shouldProcess = false;
    const record = await this.updateRecord(key, (current) => {
      if (!current) {
        shouldProcess = true;
        return initial;
      }
      if (current.status === "complete" || current.terminalCode === "cancelled") {
        return current;
      }
      const contentGrew = input.messageCount > current.messageCount;
      const planChanged = input.plan.fingerprint !== current.plan.fingerprint;
      const configChanged =
        input.generationConfigFingerprint !== current.generationConfigFingerprint;
      const invalidateCandidateWork =
        current.candidate === null && (contentGrew || planChanged || configChanged);
      const status = invalidateCandidateWork ? "pending" : current.status;
      const failedRetryDue =
        status === "failed" &&
        current.terminalCode === null &&
        current.attemptCount < SESSION_MEMORY_FLUSH_MAX_ATTEMPTS &&
        current.nextAttemptAt !== null &&
        current.nextAttemptAt <= now;
      const leaseExpired =
        status === "processing" && (current.leaseExpiresAt ?? current.processingAt ?? 0) <= now;
      shouldProcess = status === "pending" || failedRetryDue || leaseExpired;
      return {
        ...current,
        sessionKey,
        status,
        endedAt: invalidateCandidateWork ? initial.endedAt : current.endedAt,
        messageCount: Math.max(current.messageCount, initial.messageCount),
        maxPromptTokens: invalidateCandidateWork ? input.maxPromptTokens : current.maxPromptTokens,
        generationConfigFingerprint: invalidateCandidateWork
          ? input.generationConfigFingerprint
          : current.generationConfigFingerprint,
        plan: invalidateCandidateWork ? input.plan : current.plan,
        sessionFile: input.sessionFile?.trim() || current.sessionFile,
        transcriptArchived: current.transcriptArchived || input.transcriptArchived === true,
        ...(invalidateCandidateWork
          ? {
              revision: current.revision + 1,
              attemptCount: 0,
              transcriptFingerprint: null,
              extractedMessageCount: null,
              processingAt: null,
              leaseExpiresAt: null,
              nextAttemptAt: null,
              lastError: null,
              terminalCode: null,
            }
          : {}),
        updatedAt: now,
      };
    });
    if (!record) {
      throw new Error("session memory flush state disappeared during enqueue");
    }
    return { key, record, shouldProcess };
  }

  async claim(key: string): Promise<SessionMemoryFlushRecord | undefined> {
    const now = this.now();
    let claimed = false;
    const record = await this.updateRecord(key, (current) => {
      if (!current || current.status === "complete" || current.terminalCode !== null) {
        return current;
      }
      const eligible =
        current.status === "pending" ||
        (current.status === "failed" &&
          current.nextAttemptAt !== null &&
          current.nextAttemptAt <= now) ||
        (current.status === "processing" &&
          (current.leaseExpiresAt ?? current.processingAt ?? 0) <= now);
      if (!eligible) {
        return current;
      }
      if (current.attemptCount >= SESSION_MEMORY_FLUSH_MAX_ATTEMPTS) {
        return { ...current, status: "failed", nextAttemptAt: null, updatedAt: now };
      }
      claimed = true;
      return {
        ...current,
        status: "processing",
        revision: current.revision + 1,
        attemptCount: current.attemptCount + 1,
        processingAt: now,
        leaseExpiresAt: now + SESSION_MEMORY_FLUSH_PROCESSING_LEASE_MS,
        nextAttemptAt: null,
        lastError: null,
        updatedAt: now,
      };
    });
    return claimed ? record : undefined;
  }

  async persistCandidate(
    key: string,
    params: {
      candidate: SessionMemoryFlushCandidate;
      expectedRevision: number;
      extractedMessageCount: number;
      transcriptFingerprint: string;
    },
  ): Promise<SessionMemoryFlushRecord | undefined> {
    let persisted = false;
    const record = await this.updateRecord(key, (current) => {
      if (
        !current ||
        current.status !== "processing" ||
        current.revision !== params.expectedRevision ||
        current.candidate !== null
      ) {
        return current;
      }
      persisted = true;
      return {
        ...current,
        candidate: params.candidate,
        transcriptFingerprint: params.transcriptFingerprint,
        extractedMessageCount: params.extractedMessageCount,
        updatedAt: this.now(),
      };
    });
    return persisted ? record : undefined;
  }

  async markComplete(
    key: string,
    params: { expectedRevision: number; projectedAt?: number },
  ): Promise<SessionMemoryFlushRecord | undefined> {
    let completed = false;
    const now = this.now();
    const record = await this.updateRecord(key, (current) => {
      if (
        !current ||
        current.status !== "processing" ||
        current.revision !== params.expectedRevision ||
        current.candidate === null
      ) {
        return current;
      }
      completed = true;
      return {
        ...current,
        status: "complete",
        revision: current.revision + 1,
        processingAt: null,
        leaseExpiresAt: null,
        nextAttemptAt: null,
        lastError: null,
        terminalCode: null,
        projectedAt: params.projectedAt ?? current.projectedAt,
        completedAt: now,
        updatedAt: now,
      };
    });
    return completed ? record : undefined;
  }

  async markFailed(
    key: string,
    params: {
      error: string;
      expectedRevision: number;
      terminalCode?: SessionMemoryFlushTerminalCode;
    },
  ): Promise<SessionMemoryFlushRecord | undefined> {
    let failed = false;
    const now = this.now();
    const record = await this.updateRecord(key, (current) => {
      if (
        !current ||
        current.status !== "processing" ||
        current.revision !== params.expectedRevision
      ) {
        return current;
      }
      failed = true;
      const exhausted = current.attemptCount >= SESSION_MEMORY_FLUSH_MAX_ATTEMPTS;
      return {
        ...current,
        status: "failed",
        revision: current.revision + 1,
        processingAt: null,
        leaseExpiresAt: null,
        nextAttemptAt:
          params.terminalCode || exhausted ? null : now + retryDelayMs(current.attemptCount),
        lastError: params.error,
        terminalCode: params.terminalCode ?? null,
        updatedAt: now,
      };
    });
    return failed ? record : undefined;
  }

  async releaseClaim(key: string, expectedRevision: number): Promise<boolean> {
    let released = false;
    await this.updateRecord(key, (current) => {
      if (!current || current.status !== "processing" || current.revision !== expectedRevision) {
        return current;
      }
      released = true;
      return {
        ...current,
        status: "pending",
        revision: current.revision + 1,
        attemptCount: Math.max(0, current.attemptCount - 1),
        processingAt: null,
        leaseExpiresAt: null,
        nextAttemptAt: null,
        updatedAt: this.now(),
      };
    });
    return released;
  }

  async listRecoverable(): Promise<Array<{ key: string; record: SessionMemoryFlushRecord }>> {
    const entries = await this.getStore().entries();
    return entries
      .flatMap((entry) =>
        isSessionMemoryFlushRecord(entry.value) &&
        entry.value.status !== "complete" &&
        entry.value.terminalCode === null &&
        entry.value.attemptCount < SESSION_MEMORY_FLUSH_MAX_ATTEMPTS
          ? [{ key: entry.key, record: entry.value }]
          : [],
      )
      .toSorted(
        (left, right) =>
          left.record.endedAt - right.record.endedAt || left.key.localeCompare(right.key),
      );
  }

  async listCancelled(): Promise<Array<{ key: string; record: SessionMemoryFlushRecord }>> {
    const entries = await this.getStore().entries();
    return entries
      .flatMap((entry) =>
        isSessionMemoryFlushRecord(entry.value) && entry.value.terminalCode === "cancelled"
          ? [{ key: entry.key, record: entry.value }]
          : [],
      )
      .toSorted(
        (left, right) =>
          left.record.endedAt - right.record.endedAt || left.key.localeCompare(right.key),
      );
  }

  async lookup(agentId: string, sessionId: string): Promise<SessionMemoryFlushRecord | undefined> {
    return await this.lookupKey(buildSessionMemoryFlushOperationId(agentId, sessionId));
  }

  async lookupKey(key: string): Promise<SessionMemoryFlushRecord | undefined> {
    const value = await this.getStore().lookup(key);
    return isSessionMemoryFlushRecord(value) ? value : undefined;
  }

  async cancel(
    key: string,
  ): Promise<{ record: SessionMemoryFlushRecord; requiresProjectionLock: boolean } | undefined> {
    let requiresProjectionLock = false;
    let cancelled = false;
    const now = this.now();
    const record = await this.updateRecord(key, (current) => {
      if (!current) {
        return undefined;
      }
      requiresProjectionLock =
        current.status === "processing" || current.candidate?.kind === "append";
      cancelled = true;
      return {
        ...current,
        status: "failed",
        revision: current.revision + 1,
        processingAt: null,
        leaseExpiresAt: null,
        nextAttemptAt: null,
        lastError: "completed session was deleted",
        terminalCode: "cancelled",
        updatedAt: now,
      };
    });
    return cancelled && record ? { record, requiresProjectionLock } : undefined;
  }

  async purge(agentId: string, sessionId: string): Promise<void> {
    await this.getStore().delete(buildSessionMemoryFlushOperationId(agentId, sessionId));
  }
}
