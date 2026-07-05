import fs from "node:fs";
import { stripInboundMetadata } from "../auto-reply/reply/strip-inbound-meta.js";
import { readFileRangeAsync } from "../config/sessions/file-range.js";
import {
  appendTranscriptMessage,
  publishTranscriptUpdate,
  resolveSessionTranscriptRuntimeReadTarget,
  resolveSessionTranscriptRuntimeTarget,
  type TranscriptMessageAppendOptions,
  type TranscriptMessageAppendResult,
  type TranscriptUpdatePayload,
} from "../config/sessions/session-accessor.js";
import { runSessionTranscriptAppendTransaction } from "../config/sessions/transcript-append.js";
import { streamSessionTranscriptLines } from "../config/sessions/transcript-stream.js";
import {
  appendAssistantMessageToSessionTranscript,
  readLatestAssistantTextFromSessionTranscript,
  type LatestAssistantTranscriptText,
  type SessionTranscriptAppendResult,
  type SessionTranscriptDeliveryMirror,
  type SessionTranscriptUpdateMode,
} from "../config/sessions/transcript.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeAgentId } from "../routing/session-key.js";
import {
  formatSessionTranscriptMemoryHitKey,
  parseSessionTranscriptMemoryHitKey,
  resolveSessionTranscriptMemoryHitKeyToSessionKeys,
  type ResolveSessionTranscriptMemoryHitKeyParams,
  type SessionTranscriptIdentity,
  type SessionTranscriptMemoryHitIdentity,
  type SessionTranscriptMemoryHitKey,
  type SessionTranscriptMemoryHitKeyParams,
  type SessionTranscriptReadParams,
} from "./session-transcript-memory-hit.js";

export {
  formatSessionTranscriptMemoryHitKey,
  parseSessionTranscriptMemoryHitKey,
  resolveSessionTranscriptMemoryHitKeyToSessionKeys,
};
export type {
  ResolveSessionTranscriptMemoryHitKeyParams,
  SessionTranscriptIdentity,
  SessionTranscriptMemoryHitIdentity,
  SessionTranscriptMemoryHitKey,
  SessionTranscriptMemoryHitKeyParams,
  SessionTranscriptReadParams,
};

export type SessionTranscriptEvent = unknown;

export type SessionTranscriptMessageRole = "user" | "assistant";

export type BoundedSessionTranscriptReadResult = {
  /** False when the scoped transcript artifact cannot currently be read. */
  available: boolean;
  events: SessionTranscriptEvent[];
  truncated: boolean;
};

/**
 * Removes OpenClaw's model-facing inbound metadata from persisted user text.
 * Assistant text is returned unchanged so callers do not accidentally apply
 * user-envelope rules to model output.
 */
export function sanitizeSessionTranscriptMessageText(params: {
  role: SessionTranscriptMessageRole;
  text: string;
}): string {
  return params.role === "user" ? stripInboundMetadata(params.text) : params.text;
}

export type SessionTranscriptTargetParams = SessionTranscriptReadParams & {
  /**
   * @deprecated Prefer `{ agentId, sessionKey, sessionId }`. Pass this only
   * when adapting code that already receives an active transcript artifact and
   * needs each helper to operate on that same artifact.
   */
  sessionFile?: string;
};

export type BoundedSessionTranscriptReadParams = SessionTranscriptTargetParams & {
  /** Maximum JSONL source bytes retained across the head and tail windows. */
  maxBytes: number;
  /** Maximum parsed events returned across the head and tail windows. */
  maxEvents: number;
};

export type SessionTranscriptTarget = SessionTranscriptIdentity & {
  targetKind: "active-session-file" | "runtime-session";
};

/**
 * @deprecated Use SessionTranscriptTarget with `{ agentId, sessionKey,
 * sessionId }`. Active transcript file targets are transitional only and will
 * be removed with the SQLite session/transcript storage flip.
 */
export type SessionTranscriptLegacyFileTarget = SessionTranscriptTarget & {
  /** Deprecated transitional file path for active transcript artifact callers. */
  sessionFile: string;
};

export type SessionTranscriptAppendMessageParams<TMessage> = SessionTranscriptTargetParams &
  TranscriptMessageAppendOptions<TMessage>;

export type SessionTranscriptAssistantMirrorAppendParams = SessionTranscriptReadParams & {
  config?: OpenClawConfig;
  deliveryMirror?: SessionTranscriptDeliveryMirror;
  idempotencyKey?: string;
  mediaUrls?: string[];
  text?: string;
  updateMode?: SessionTranscriptUpdateMode;
};

export type SessionTranscriptWriteLockParams = SessionTranscriptTargetParams & {
  config?: TranscriptMessageAppendOptions<unknown>["config"];
};

export type SessionTranscriptWriteLockContext = {
  appendMessage: <TMessage>(
    options: Omit<TranscriptMessageAppendOptions<TMessage>, "config">,
  ) => Promise<TranscriptMessageAppendResult<TMessage> | undefined>;
  publishUpdate: (update?: TranscriptUpdatePayload) => Promise<void>;
  readEvents: () => Promise<SessionTranscriptEvent[]>;
  target: SessionTranscriptTarget;
};

/**
 * Resolves the public identity for a transcript without returning its file path.
 */
export async function resolveSessionTranscriptIdentity(
  params: SessionTranscriptReadParams,
): Promise<SessionTranscriptIdentity> {
  const target = await resolveSessionTranscriptRuntimeReadTarget(params);
  const agentId = normalizeAgentId(target.agentId);
  return {
    agentId,
    memoryKey: formatSessionTranscriptMemoryHitKey({ agentId, sessionId: target.sessionId }),
    sessionId: target.sessionId,
    sessionKey: target.sessionKey,
  };
}

/**
 * Resolves the public target for transcript operations without exposing the
 * current storage path as identity.
 */
export async function resolveSessionTranscriptTarget(
  params: SessionTranscriptTargetParams,
): Promise<SessionTranscriptTarget> {
  const target = await resolveSessionTranscriptRuntimeReadTarget(params);
  return projectPublicTarget({
    ...target,
    targetKind: params.sessionFile?.trim() ? "active-session-file" : "runtime-session",
  });
}

/**
 * @deprecated Use resolveSessionTranscriptTarget with `{ agentId, sessionKey,
 * sessionId }`. This persists an active transcript file target only for legacy
 * plugin command calls that still require `sessionFile`.
 */
export async function resolveSessionTranscriptLegacyFileTarget(
  params: SessionTranscriptTargetParams,
): Promise<SessionTranscriptLegacyFileTarget> {
  const target = await resolveSessionTranscriptRuntimeTarget(params);
  return {
    ...projectPublicTarget({
      ...target,
      targetKind: params.sessionFile?.trim() ? "active-session-file" : "runtime-session",
    }),
    sessionFile: target.sessionFile,
  };
}

/**
 * Reads transcript events by public session identity instead of file path.
 */
export async function readSessionTranscriptEvents(
  params: SessionTranscriptTargetParams,
): Promise<SessionTranscriptEvent[]> {
  const target = await resolveSessionTranscriptRuntimeReadTarget(params);
  const events: SessionTranscriptEvent[] = [];
  for await (const line of streamSessionTranscriptLines(target.sessionFile)) {
    try {
      events.push(JSON.parse(line) as SessionTranscriptEvent);
    } catch {
      continue;
    }
  }
  return events;
}

function parseTranscriptEvent(line: string): SessionTranscriptEvent | undefined {
  try {
    return JSON.parse(line) as SessionTranscriptEvent;
  } catch {
    return undefined;
  }
}

function normalizeReadBound(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive safe integer`);
  }
  return value;
}

function parseBoundedTranscriptBuffer(params: {
  buffer: Buffer;
  discardLeadingPartialLine: boolean;
  discardTrailingPartialLine: boolean;
  maxEvents: number;
  retention?: "head" | "tail" | "head-tail";
}): { events: SessionTranscriptEvent[]; truncated: boolean } {
  let start = 0;
  let end = params.buffer.length;
  if (params.discardLeadingPartialLine) {
    const firstNewline = params.buffer.indexOf(0x0a);
    if (firstNewline < 0) {
      return { events: [], truncated: params.buffer.length > 0 };
    }
    start = firstNewline + 1;
  }
  if (params.discardTrailingPartialLine && end > start && params.buffer[end - 1] !== 0x0a) {
    const lastNewline = params.buffer.lastIndexOf(0x0a, end - 1);
    if (lastNewline < start) {
      return { events: [], truncated: true };
    }
    end = lastNewline + 1;
  }

  const retention = params.retention ?? "head-tail";
  const headCount =
    retention === "head"
      ? params.maxEvents
      : retention === "tail"
        ? 0
        : params.maxEvents >= 5
          ? Math.max(1, Math.floor(params.maxEvents / 5))
          : 0;
  const tailCount = retention === "head" ? 0 : params.maxEvents - headCount;
  const all: SessionTranscriptEvent[] = [];
  const head: SessionTranscriptEvent[] = [];
  const tail: SessionTranscriptEvent[] = [];
  let validCount = 0;
  let lineStart = start;
  for (let index = start; index <= end; index += 1) {
    if (index < end && params.buffer[index] !== 0x0a) {
      continue;
    }
    const lineEnd = index === end ? end : index;
    const line = params.buffer.subarray(lineStart, lineEnd).toString("utf8").trim();
    lineStart = index + 1;
    if (!line) {
      continue;
    }
    const event = parseTranscriptEvent(line);
    if (event === undefined) {
      continue;
    }
    validCount += 1;
    if (validCount <= params.maxEvents) {
      all.push(event);
    }
    if (head.length < headCount) {
      head.push(event);
    }
    if (tailCount > 0) {
      tail.push(event);
      if (tail.length > tailCount) {
        tail.shift();
      }
    }
  }
  return validCount <= params.maxEvents
    ? { events: all, truncated: false }
    : { events: [...head, ...tail], truncated: true };
}

/**
 * Reads a memory-bounded head/tail view of a transcript by scoped identity.
 * The reader pins one file-size snapshot and reads at most maxBytes from that
 * snapshot, so concurrent appends and many tiny events cannot expand retained
 * memory beyond the caller's explicit byte/event bounds.
 */
export async function readBoundedSessionTranscriptEvents(
  params: BoundedSessionTranscriptReadParams,
): Promise<BoundedSessionTranscriptReadResult> {
  const maxBytes = normalizeReadBound(params.maxBytes, "maxBytes");
  const maxEvents = normalizeReadBound(params.maxEvents, "maxEvents");
  const target = await resolveSessionTranscriptRuntimeReadTarget(params);
  let fileHandle: Awaited<ReturnType<typeof fs.promises.open>>;
  try {
    fileHandle = await fs.promises.open(target.sessionFile, "r");
  } catch {
    return { available: false, events: [], truncated: false };
  }
  try {
    const stat = await fileHandle.stat();
    if (!stat.isFile()) {
      return { available: false, events: [], truncated: false };
    }
    if (stat.size <= 0) {
      return { available: true, events: [], truncated: false };
    }
    if (stat.size <= maxBytes) {
      const buffer = await readFileRangeAsync(fileHandle, 0, stat.size);
      const parsed = parseBoundedTranscriptBuffer({
        buffer,
        discardLeadingPartialLine: false,
        discardTrailingPartialLine: false,
        maxEvents,
      });
      return { available: true, ...parsed };
    }

    const requestedHeadEvents = maxEvents >= 5 ? Math.max(1, Math.floor(maxEvents / 5)) : 0;
    let headBytes =
      requestedHeadEvents > 0 && maxBytes > 1 ? Math.max(1, Math.floor(maxBytes / 5)) : 0;
    const tailBytes = maxBytes - headBytes;
    // Spend one byte from the head budget to inspect the byte immediately
    // before the tail range. That preserves a complete first tail line when the
    // range happens to start exactly on a line boundary without exceeding the
    // caller's aggregate byte bound.
    const tailBoundaryProbeBytes = headBytes > 1 && stat.size > tailBytes ? 1 : 0;
    headBytes -= tailBoundaryProbeBytes;
    const tailReadStart = stat.size - tailBytes - tailBoundaryProbeBytes;
    const [headBuffer, tailBuffer] = await Promise.all([
      readFileRangeAsync(fileHandle, 0, headBytes),
      readFileRangeAsync(fileHandle, tailReadStart, tailBytes + tailBoundaryProbeBytes),
    ]);
    const headEvents = requestedHeadEvents;
    const tailEvents = Math.max(1, maxEvents - headEvents);
    const head = parseBoundedTranscriptBuffer({
      buffer: headBuffer,
      discardLeadingPartialLine: false,
      discardTrailingPartialLine: true,
      maxEvents: Math.max(1, headEvents),
      retention: "head",
    }).events.slice(0, headEvents);
    const tail = parseBoundedTranscriptBuffer({
      buffer: tailBuffer,
      discardLeadingPartialLine: tailBoundaryProbeBytes === 0 || tailBuffer[0] !== 0x0a,
      discardTrailingPartialLine: false,
      maxEvents: tailEvents,
      retention: "tail",
    }).events.slice(-tailEvents);
    return { available: true, events: [...head, ...tail], truncated: true };
  } finally {
    await fileHandle.close().catch(() => undefined);
  }
}

/**
 * Reads the latest visible assistant text by scoped identity using the
 * bounded reverse transcript reader.
 */
export async function readLatestAssistantTextByIdentity(
  params: SessionTranscriptTargetParams,
): Promise<LatestAssistantTranscriptText | undefined> {
  const target = await resolveSessionTranscriptRuntimeReadTarget(params);
  return await readLatestAssistantTextFromSessionTranscript(target.sessionFile);
}

/**
 * Appends a delivery-mirror assistant message through the guarded session
 * append facade.
 */
export async function appendAssistantMirrorMessageByIdentity(
  params: SessionTranscriptAssistantMirrorAppendParams,
): Promise<SessionTranscriptAppendResult> {
  return await appendAssistantMessageToSessionTranscript({
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    expectedSessionId: params.sessionId,
    ...(params.text !== undefined ? { text: params.text } : {}),
    ...(params.mediaUrls !== undefined ? { mediaUrls: params.mediaUrls } : {}),
    ...(params.idempotencyKey !== undefined ? { idempotencyKey: params.idempotencyKey } : {}),
    ...(params.deliveryMirror !== undefined ? { deliveryMirror: params.deliveryMirror } : {}),
    ...(params.storePath !== undefined ? { storePath: params.storePath } : {}),
    ...(params.updateMode !== undefined ? { updateMode: params.updateMode } : {}),
    ...(params.config !== undefined ? { config: params.config } : {}),
  });
}

/**
 * Appends a transcript message by scoped transcript target.
 */
export async function appendSessionTranscriptMessageByIdentity<TMessage>(
  params: SessionTranscriptAppendMessageParams<TMessage>,
): Promise<TranscriptMessageAppendResult<TMessage> | undefined> {
  return await appendTranscriptMessage(params, params);
}

/**
 * Publishes a transcript update by scoped transcript target.
 */
export async function publishSessionTranscriptUpdateByIdentity(
  params: SessionTranscriptTargetParams & { update?: TranscriptUpdatePayload },
): Promise<void> {
  const target = await resolveSessionTranscriptRuntimeTarget(params);
  await publishTranscriptUpdate(
    {
      ...params,
      sessionFile: target.sessionFile,
    },
    {
      ...params.update,
      agentId: target.agentId,
      sessionKey: target.sessionKey,
    },
  );
}

/**
 * Runs transcript work under the write lock for the resolved scoped target.
 */
export async function withSessionTranscriptWriteLock<T>(
  params: SessionTranscriptWriteLockParams,
  run: (context: SessionTranscriptWriteLockContext) => Promise<T> | T,
): Promise<T> {
  const storageTarget = await resolveSessionTranscriptRuntimeTarget(params);
  const target = projectPublicTarget({
    ...storageTarget,
    targetKind: params.sessionFile?.trim() ? "active-session-file" : "runtime-session",
  });
  const boundScope = {
    ...params,
    sessionFile: storageTarget.sessionFile,
  };
  // Treat publishUpdate as a post-commit callback: future transactional stores
  // must not expose updates when the scoped write callback fails.
  const queuedUpdates: Array<TranscriptUpdatePayload | undefined> = [];
  const result = await runSessionTranscriptAppendTransaction(
    {
      config: params.config,
      transcriptPath: storageTarget.sessionFile,
    },
    (transaction) =>
      run({
        target,
        readEvents: () => readSessionTranscriptEvents(boundScope),
        appendMessage: (options) =>
          transaction.appendMessage({
            ...options,
            sessionId: params.sessionId,
          }),
        publishUpdate: async (update) => {
          queuedUpdates.push(update ? { ...update } : undefined);
        },
      }),
  );
  for (const update of queuedUpdates) {
    await publishSessionTranscriptUpdateByIdentity({
      ...boundScope,
      update,
    });
  }
  return result;
}

function projectPublicTarget(target: {
  agentId: string;
  sessionId: string;
  sessionKey: string;
  targetKind: SessionTranscriptTarget["targetKind"];
}): SessionTranscriptTarget {
  const agentId = normalizeAgentId(target.agentId);
  return {
    agentId,
    memoryKey: formatSessionTranscriptMemoryHitKey({ agentId, sessionId: target.sessionId }),
    sessionId: target.sessionId,
    sessionKey: target.sessionKey,
    targetKind: target.targetKind,
  };
}
