// Lightweight in-memory queue for human-readable system events that should be
// prefixed to the next prompt. We intentionally avoid persistence to keep
// events ephemeral. Events are session-scoped and require an explicit key.

import { randomUUID } from "node:crypto";
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { normalizeChatType, type ChatType } from "../channels/chat-type.js";
import { channelRouteDedupeKey } from "../plugin-sdk/channel-route.js";
import { sanitizeInboundSystemTags } from "../security/system-tags.js";
import { inputProvenanceIdentity, type InputProvenance } from "../sessions/input-provenance.js";
import { resolveGlobalMap } from "../shared/global-singleton.js";
import {
  mergeDeliveryContext,
  normalizeDeliveryContext,
} from "../utils/delivery-context.shared.js";
import type { DeliveryContext } from "../utils/delivery-context.types.js";

export type SystemEvent = {
  text: string;
  ts: number;
  contextKey?: string | null;
  deliveryContext?: DeliveryContext;
  chatType?: ChatType;
  senderId?: string;
  inputProvenance?: InputProvenance;
  /** Host-verified authority carried by the internal producer, never inferred from delivery. */
  sourceAuthority?: { kind: "owner" };
  consumer?: "system-event-turn";
};

export type SystemEventEnqueueResult =
  | { status: "enqueued"; event: SystemEvent }
  | { status: "skipped"; reason: "empty" | "duplicate" | "full" };

const MAX_EVENTS = 20;

type SessionQueue = {
  queue: SystemEvent[];
  lastContextKey: string | null;
  claims?: Map<string, SystemEvent[]>;
};

const SYSTEM_EVENT_QUEUES_KEY = Symbol.for("openclaw.systemEvents.queues");

const queues = resolveGlobalMap<string, SessionQueue>(SYSTEM_EVENT_QUEUES_KEY);

type SystemEventOptions = {
  sessionKey: string;
  contextKey?: string | null;
  deliveryContext?: DeliveryContext;
  chatType?: ChatType;
  senderId?: string;
  inputProvenance?: InputProvenance;
  sourceAuthority?: { kind: "owner" };
  consumer?: "system-event-turn";
};

function requireSessionKey(key?: string | null): string {
  const trimmed = normalizeOptionalString(key) ?? "";
  if (!trimmed) {
    throw new Error("system events require a sessionKey");
  }
  return trimmed;
}

function normalizeContextKey(key?: string | null): string | null {
  return normalizeOptionalLowercaseString(key) ?? null;
}

function getSessionQueue(sessionKey: string): SessionQueue | undefined {
  return queues.get(requireSessionKey(sessionKey));
}

function getOrCreateSessionQueue(sessionKey: string): SessionQueue {
  const key = requireSessionKey(sessionKey);
  const existing = queues.get(key);
  if (existing) {
    return existing;
  }
  const created: SessionQueue = {
    queue: [],
    lastContextKey: null,
    claims: new Map(),
  };
  queues.set(key, created);
  return created;
}

function getClaims(entry: SessionQueue): Map<string, SystemEvent[]> {
  entry.claims ??= new Map();
  return entry.claims;
}

function listClaimedEvents(entry: SessionQueue): SystemEvent[] {
  return [...getClaims(entry).values()].flat();
}

function listResidentEvents(entry: SessionQueue): SystemEvent[] {
  return [...entry.queue, ...listClaimedEvents(entry)];
}

function cloneSystemEvent(event: SystemEvent): SystemEvent {
  return {
    ...event,
    ...(event.deliveryContext ? { deliveryContext: { ...event.deliveryContext } } : {}),
    ...(event.sourceAuthority ? { sourceAuthority: { ...event.sourceAuthority } } : {}),
  };
}

export function isSystemEventContextChanged(
  sessionKey: string,
  contextKey?: string | null,
): boolean {
  const existing = getSessionQueue(sessionKey);
  const normalized = normalizeContextKey(contextKey);
  return normalized !== (existing?.lastContextKey ?? null);
}

function findDuplicateInQueue(
  queue: readonly SystemEvent[],
  text: string,
  contextKey: string | null,
  deliveryContext: DeliveryContext | undefined,
  chatType: ChatType | undefined,
  senderId: string | undefined,
  inputProvenance: InputProvenance | undefined,
  sourceAuthority: SystemEvent["sourceAuthority"],
  consumer: SystemEvent["consumer"],
): boolean {
  const incoming = {
    text,
    contextKey,
    deliveryContext,
    chatType,
    senderId,
    inputProvenance,
    sourceAuthority,
    consumer,
  };
  if (contextKey === null) {
    const last = queue[queue.length - 1];
    return last ? isDuplicateSystemEvent(last, incoming) : false;
  }
  return queue.some((event) => isDuplicateSystemEvent(event, incoming));
}

export function enqueueSystemEventEntryWithStatus(
  text: string,
  options: SystemEventOptions,
): SystemEventEnqueueResult {
  const key = requireSessionKey(options.sessionKey);
  const entry = getOrCreateSessionQueue(key);
  // These entries are rendered as `System:` lines, so strip nested system-marker
  // spoofs at the queue boundary before any plugin/channel text reaches a prompt.
  const cleaned = sanitizeInboundSystemTags(text).trim();
  if (!cleaned) {
    return { status: "skipped", reason: "empty" };
  }
  const normalizedContextKey = normalizeContextKey(options.contextKey);
  const normalizedDeliveryContext = normalizeDeliveryContext(options.deliveryContext);
  const chatType = normalizeChatType(options.chatType);
  const senderId = normalizedDeliveryContext
    ? normalizeOptionalString(options.senderId)
    : undefined;
  if (
    findDuplicateInQueue(
      listResidentEvents(entry),
      cleaned,
      normalizedContextKey,
      normalizedDeliveryContext,
      chatType,
      senderId,
      options.inputProvenance,
      options.sourceAuthority,
      options.consumer,
    )
  ) {
    return { status: "skipped", reason: "duplicate" };
  }
  if (listResidentEvents(entry).length >= MAX_EVENTS) {
    const evictableIndex = entry.queue.findIndex((event) => !isSystemEventTurnOwned(event));
    if (evictableIndex === -1) {
      return { status: "skipped", reason: "full" };
    }
    entry.queue.splice(evictableIndex, 1);
    resetQueueState(key, entry);
  }
  if (normalizedContextKey !== null) {
    entry.lastContextKey = normalizedContextKey;
  }
  const event: SystemEvent = {
    text: cleaned,
    ts: Date.now(),
    contextKey: normalizedContextKey,
    deliveryContext: normalizedDeliveryContext,
    ...(chatType ? { chatType } : {}),
    ...(senderId ? { senderId } : {}),
    ...(options.inputProvenance ? { inputProvenance: options.inputProvenance } : {}),
    ...(options.sourceAuthority ? { sourceAuthority: options.sourceAuthority } : {}),
    ...(options.consumer ? { consumer: options.consumer } : {}),
  };
  entry.queue.push(event);
  return { status: "enqueued", event: cloneSystemEvent(event) };
}

export function enqueueSystemEventEntry(
  text: string,
  options: SystemEventOptions,
): SystemEvent | null {
  const result = enqueueSystemEventEntryWithStatus(text, options);
  return result.status === "enqueued" ? result.event : null;
}

export function enqueueSystemEvent(text: string, options: SystemEventOptions) {
  return enqueueSystemEventEntry(text, options) !== null;
}

export function drainSystemEventEntries(sessionKey: string): SystemEvent[] {
  const key = requireSessionKey(sessionKey);
  const entry = getSessionQueue(key);
  if (!entry || entry.queue.length === 0) {
    return [];
  }
  const out = entry.queue.map(cloneSystemEvent);
  entry.queue.length = 0;
  resetQueueState(key, entry);
  return out;
}

function areDeliveryContextsEqual(left?: DeliveryContext, right?: DeliveryContext): boolean {
  if (!left && !right) {
    return true;
  }
  if (!left || !right) {
    return false;
  }
  return channelRouteDedupeKey(left) === channelRouteDedupeKey(right);
}

function isDuplicateSystemEvent(
  existing: SystemEvent,
  incoming: Pick<
    SystemEvent,
    | "text"
    | "contextKey"
    | "deliveryContext"
    | "chatType"
    | "senderId"
    | "inputProvenance"
    | "sourceAuthority"
    | "consumer"
  >,
): boolean {
  return (
    existing.text === incoming.text &&
    (existing.contextKey ?? null) === (incoming.contextKey ?? null) &&
    areDeliveryContextsEqual(existing.deliveryContext, incoming.deliveryContext) &&
    existing.chatType === incoming.chatType &&
    existing.senderId === incoming.senderId &&
    inputProvenanceIdentity(existing.inputProvenance) ===
      inputProvenanceIdentity(incoming.inputProvenance) &&
    existing.sourceAuthority?.kind === incoming.sourceAuthority?.kind &&
    existing.consumer === incoming.consumer
  );
}

function areSystemEventsEqual(left: SystemEvent, right: SystemEvent): boolean {
  return (
    left.text === right.text &&
    left.ts === right.ts &&
    (left.contextKey ?? null) === (right.contextKey ?? null) &&
    areDeliveryContextsEqual(left.deliveryContext, right.deliveryContext) &&
    left.chatType === right.chatType &&
    left.senderId === right.senderId &&
    inputProvenanceIdentity(left.inputProvenance) ===
      inputProvenanceIdentity(right.inputProvenance) &&
    left.sourceAuthority?.kind === right.sourceAuthority?.kind &&
    left.consumer === right.consumer
  );
}

export function isSystemEventTurnOwned(event: SystemEvent): boolean {
  return event.consumer === "system-event-turn";
}

function resetQueueState(key: string, entry: SessionQueue) {
  const residentEvents = listResidentEvents(entry);
  if (residentEvents.length === 0) {
    entry.lastContextKey = null;
    queues.delete(key);
    return;
  }
  let newestContextEvent: SystemEvent | undefined;
  for (const event of residentEvents) {
    if (event.contextKey != null && (!newestContextEvent || event.ts >= newestContextEvent.ts)) {
      newestContextEvent = event;
    }
  }
  entry.lastContextKey = newestContextEvent?.contextKey ?? null;
}

export function consumeSystemEventEntries(
  sessionKey: string,
  consumedEntries: readonly SystemEvent[],
): SystemEvent[] {
  const key = requireSessionKey(sessionKey);
  const entry = getSessionQueue(key);
  if (!entry || entry.queue.length === 0 || consumedEntries.length === 0) {
    return [];
  }
  if (
    consumedEntries.length > entry.queue.length ||
    !consumedEntries.every((event, index) => areSystemEventsEqual(entry.queue[index], event))
  ) {
    return [];
  }
  const removed = entry.queue.splice(0, consumedEntries.length).map(cloneSystemEvent);
  resetQueueState(key, entry);
  return removed;
}

export function consumeSelectedSystemEventEntries(
  sessionKey: string,
  consumedEntries: readonly SystemEvent[],
): SystemEvent[] {
  const key = requireSessionKey(sessionKey);
  const entry = getSessionQueue(key);
  if (!entry || entry.queue.length === 0 || consumedEntries.length === 0) {
    return [];
  }
  const removed: SystemEvent[] = [];
  for (const consumed of consumedEntries) {
    const index = entry.queue.findIndex((event) => areSystemEventsEqual(event, consumed));
    if (index === -1) {
      continue;
    }
    const [event] = entry.queue.splice(index, 1);
    if (event) {
      removed.push(cloneSystemEvent(event));
    }
  }
  resetQueueState(key, entry);
  return removed;
}

export type SystemEventClaim = {
  claimId: string;
  events: SystemEvent[];
};

/** Atomically reserves queued entries while keeping them resident for capacity and dedupe. */
export function claimSelectedSystemEventEntries(
  sessionKey: string,
  selectedEntries: readonly SystemEvent[],
): SystemEventClaim | null {
  const key = requireSessionKey(sessionKey);
  const entry = getSessionQueue(key);
  if (!entry || selectedEntries.length === 0) {
    return null;
  }
  const selectedIndexes: number[] = [];
  const usedIndexes = new Set<number>();
  for (const selected of selectedEntries) {
    const index = entry.queue.findIndex(
      (event, candidateIndex) =>
        !usedIndexes.has(candidateIndex) && areSystemEventsEqual(event, selected),
    );
    if (index === -1) {
      return null;
    }
    usedIndexes.add(index);
    selectedIndexes.push(index);
  }
  const events = selectedIndexes.map((index) => cloneSystemEvent(entry.queue[index]!));
  for (const index of selectedIndexes.toSorted((left, right) => right - left)) {
    entry.queue.splice(index, 1);
  }
  const claimId = randomUUID();
  getClaims(entry).set(claimId, events.map(cloneSystemEvent));
  resetQueueState(key, entry);
  return { claimId, events };
}

/** Releases a successful claim without returning its entries to the pending queue. */
export function completeSystemEventClaim(sessionKey: string, claimId: string): SystemEvent[] {
  const key = requireSessionKey(sessionKey);
  const entry = getSessionQueue(key);
  const events = entry ? getClaims(entry).get(claimId) : undefined;
  if (!entry || !events) {
    return [];
  }
  getClaims(entry).delete(claimId);
  resetQueueState(key, entry);
  return events.map(cloneSystemEvent);
}

/** Releases a failed claim back to the queue in original timestamp order. */
export function restoreSystemEventClaim(sessionKey: string, claimId: string): SystemEvent[] {
  const key = requireSessionKey(sessionKey);
  const entry = getSessionQueue(key);
  const events = entry ? getClaims(entry).get(claimId) : undefined;
  if (!entry || !events) {
    return [];
  }
  getClaims(entry).delete(claimId);
  for (const event of events) {
    if (!entry.queue.some((queued) => areSystemEventsEqual(queued, event))) {
      entry.queue.push(cloneSystemEvent(event));
    }
  }
  entry.queue.sort((left, right) => left.ts - right.ts);
  resetQueueState(key, entry);
  return events.map(cloneSystemEvent);
}

export function drainSystemEvents(sessionKey: string): string[] {
  return drainSystemEventEntries(sessionKey).map((event) => event.text);
}

export function peekSystemEventEntries(sessionKey: string): SystemEvent[] {
  return getSessionQueue(sessionKey)?.queue.map(cloneSystemEvent) ?? [];
}

export function peekSystemEvents(sessionKey: string): string[] {
  return peekSystemEventEntries(sessionKey).map((event) => event.text);
}

export function hasSystemEvents(sessionKey: string) {
  return (getSessionQueue(sessionKey)?.queue.length ?? 0) > 0;
}

export function resolveSystemEventDeliveryContext(
  events: readonly SystemEvent[],
): DeliveryContext | undefined {
  let resolved: DeliveryContext | undefined;
  for (const event of events) {
    resolved = mergeDeliveryContext(event.deliveryContext, resolved);
  }
  return resolved;
}

export function resetSystemEventsForTest() {
  queues.clear();
}
