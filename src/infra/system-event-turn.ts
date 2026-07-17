import { resolveEmbeddedSessionLane } from "../agents/embedded-agent-runner/lanes.js";
import type { OriginatingChannelType, MsgContext } from "../auto-reply/templating.js";
import type { ChatType } from "../channels/chat-type.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { channelRouteDedupeKey } from "../plugin-sdk/channel-route.js";
import { enqueueCommandInLane } from "../process/command-queue.js";
import { createLazyImportLoader } from "../shared/lazy-promise.js";
import type { DeliveryContext } from "../utils/delivery-context.types.js";
import {
  consumeSelectedSystemEventEntries,
  isSystemEventTurnOwned,
  peekSystemEventEntries,
  restoreSystemEventEntries,
  type SystemEvent,
} from "./system-events.js";

const DEFAULT_COALESCE_MS = 300;
const RETRY_BASE_MS = 1_000;
const RETRY_MAX_MS = 30_000;
const MAX_RETRY_ATTEMPTS = 3;
const SYSTEM_EVENT_TRANSCRIPT = "[OpenClaw system event]";
const SYSTEM_EVENT_INSTRUCTION =
  "Process the system event(s) above. Follow their instructions. Reply NO_REPLY when no user-facing response is needed.";

const log = createSubsystemLogger("system-event-turn");
const runtimeLoader = createLazyImportLoader(() => import("./system-event-turn.runtime.js"));

type PendingSystemEventTurn = {
  reason?: string;
  coalesceMs: number;
  running: boolean;
  rerunRequested: boolean;
  failedAttempts: number;
  retryEvents?: readonly SystemEvent[];
};

class SystemEventTurnAttemptError extends Error {
  constructor(
    cause: unknown,
    readonly events: readonly SystemEvent[],
  ) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = "SystemEventTurnAttemptError";
  }
}

export type SystemEventTurnResult =
  | { status: "skipped"; reason: "no-events" }
  | {
      status: "ran";
      eventCount: number;
      hasDeliveryTarget: boolean;
      counts: { tool: number; block: number; final: number };
    };

const pendingTurns = new Map<string, PendingSystemEventTurn>();

function isRunnableSystemEvent(event: SystemEvent): boolean {
  return isSystemEventTurnOwned(event);
}

function hasRunnableSystemEvents(sessionKey: string): boolean {
  return peekSystemEventEntries(sessionKey).some(isRunnableSystemEvent);
}

function systemEventIdentity(event: SystemEvent): string {
  return JSON.stringify([
    event.text,
    event.ts,
    event.contextKey ?? null,
    channelRouteDedupeKey(event.deliveryContext),
    event.chatType ?? null,
    event.senderId ?? null,
    event.consumer ?? null,
  ]);
}

function selectRequestedSystemEvents(
  events: readonly SystemEvent[],
  requested: readonly SystemEvent[] | undefined,
): SystemEvent[] {
  if (!requested) {
    return events.filter(isRunnableSystemEvent);
  }
  const requestedIds = new Set(requested.map(systemEventIdentity));
  return events.filter(
    (event) => isRunnableSystemEvent(event) && requestedIds.has(systemEventIdentity(event)),
  );
}

type SystemEventDeliveryRoute = {
  delivery?: DeliveryContext;
  chatType?: ChatType;
  senderId?: string;
};

// Route dedupe key ignoring accountId — used to decide whether an event route
// that omits accountId is the same route as the fallback.
function routeKeyWithoutAccount(delivery: DeliveryContext | undefined): string {
  return channelRouteDedupeKey({
    channel: delivery?.channel,
    to: delivery?.to,
    threadId: delivery?.threadId,
  });
}

// Hooks/cron announces can persist an event delivery route with no accountId
// (e.g. `channel=signal, to=<uuid>`) while the session that established the
// owner sender stored `accountId=default`. Backfill the fallback's accountId
// when the event omits it and the routes are otherwise identical, so the strict
// dedupe comparison still recognizes the same route and preserves the owner.
function reconcileEventDeliveryAccountId(
  event: DeliveryContext,
  fallback: DeliveryContext | undefined,
): DeliveryContext {
  if (event.accountId || !fallback?.accountId) {
    return event;
  }
  return routeKeyWithoutAccount(event) === routeKeyWithoutAccount(fallback)
    ? { ...event, accountId: fallback.accountId }
    : event;
}

function resolveEventDeliveryRoute(
  event: SystemEvent,
  fallback: SystemEventDeliveryRoute,
): SystemEventDeliveryRoute {
  const hasEventDelivery = Boolean(event.deliveryContext?.channel && event.deliveryContext.to);
  const reconciledDelivery =
    hasEventDelivery && event.deliveryContext
      ? reconcileEventDeliveryAccountId(event.deliveryContext, fallback.delivery)
      : undefined;
  const reusesFallbackDelivery =
    !hasEventDelivery ||
    channelRouteDedupeKey(reconciledDelivery) === channelRouteDedupeKey(fallback.delivery);
  return {
    delivery: hasEventDelivery ? reconciledDelivery : fallback.delivery,
    chatType: event.chatType ?? (reusesFallbackDelivery ? fallback.chatType : undefined),
    // Sender identity participates in command authorization, so it can cross
    // only with the exact channel/account/target/thread route that established it.
    senderId: hasEventDelivery
      ? (event.senderId ?? (reusesFallbackDelivery ? fallback.senderId : undefined))
      : fallback.senderId,
  };
}

function systemEventDeliveryRouteKey(route: SystemEventDeliveryRoute): string {
  return `${channelRouteDedupeKey(route.delivery)}\u0000${route.chatType ?? ""}\u0000${route.senderId ?? ""}`;
}

function selectSystemEventBatch(params: {
  events: readonly SystemEvent[];
  fallbackRoute: SystemEventDeliveryRoute;
}): { events: SystemEvent[]; route: SystemEventDeliveryRoute } | undefined {
  const runnableEvents = params.events.filter(isRunnableSystemEvent);
  const first = runnableEvents[0];
  if (!first) {
    return undefined;
  }
  const route = resolveEventDeliveryRoute(first, params.fallbackRoute);
  const deliveryKey = systemEventDeliveryRouteKey(route);
  return {
    events: runnableEvents.filter(
      (event) =>
        systemEventDeliveryRouteKey(resolveEventDeliveryRoute(event, params.fallbackRoute)) ===
        deliveryKey,
    ),
    route,
  };
}

function buildSystemEventPrompt(events: readonly SystemEvent[]): string {
  const lines = events.flatMap((event) => {
    const timestamp = new Date(event.ts).toISOString();
    return event.text
      .split("\n")
      .map((line, index) => (index === 0 ? `Event: [${timestamp}] ${line}` : `Event: ${line}`));
  });
  return [SYSTEM_EVENT_TRANSCRIPT, ...lines, "", SYSTEM_EVENT_INSTRUCTION].join("\n");
}

function buildSystemEventContext(params: {
  sessionKey: string;
  events: readonly SystemEvent[];
  delivery?: DeliveryContext;
  chatType?: MsgContext["ChatType"];
  senderId?: string;
}): MsgContext {
  const delivery = params.delivery;
  const hasDeliveryTarget = Boolean(delivery?.channel && delivery.to);
  // Provider marks the internal lifecycle, while OriginatingChannel remains the
  // authorization surface. Setting Surface here would hide the real channel and
  // incorrectly strip owner-only tools from routed automation turns.
  return {
    Body: buildSystemEventPrompt(params.events),
    TranscriptBody: SYSTEM_EVENT_TRANSCRIPT,
    ...(params.senderId ? { From: params.senderId, SenderId: params.senderId } : {}),
    ...(delivery?.to ? { To: delivery.to } : {}),
    ...(delivery?.channel
      ? {
          OriginatingChannel: delivery.channel as OriginatingChannelType,
          OriginatingTo: delivery.to,
        }
      : {}),
    ...(delivery?.accountId ? { AccountId: delivery.accountId } : {}),
    ...(delivery?.threadId != null ? { MessageThreadId: delivery.threadId } : {}),
    ...(params.chatType ? { ChatType: params.chatType } : {}),
    Provider: "system-event",
    SessionKey: params.sessionKey,
    CommandAuthorized: true,
    ExplicitDeliverRoute: hasDeliveryTarget,
    SuppressMessageReceivedHooks: true,
  };
}

function hasSystemEventDeliveryFailure(result: {
  failedCounts?: Partial<Record<"tool" | "block" | "final", number>>;
}): boolean {
  return (
    (result.failedCounts?.tool ?? 0) > 0 ||
    (result.failedCounts?.block ?? 0) > 0 ||
    (result.failedCounts?.final ?? 0) > 0
  );
}

type RunSystemEventTurnParams = {
  sessionKey: string;
  reason?: string;
  abortSignal?: AbortSignal;
};

async function runSystemEventTurnAttempt(
  params: RunSystemEventTurnParams,
  requestedEvents?: readonly SystemEvent[],
): Promise<SystemEventTurnResult> {
  const sessionKey = params.sessionKey.trim();
  if (!sessionKey) {
    throw new Error("system event turns require a sessionKey");
  }

  // Wait behind the current turn without owning the lane while the nested agent
  // runtime starts; holding it here would deadlock the runtime's own lane entry.
  await enqueueCommandInLane(resolveEmbeddedSessionLane(sessionKey), async () => undefined, {
    priority: "background",
    warnAfterMs: 10_000,
  });
  params.abortSignal?.throwIfAborted();

  const events = selectRequestedSystemEvents(peekSystemEventEntries(sessionKey), requestedEvents);
  if (events.length === 0) {
    log.debug("system event turn skipped because the queue was already drained", {
      reason: params.reason,
      sessionKey,
    });
    return { status: "skipped", reason: "no-events" };
  }

  let claimedEvents: readonly SystemEvent[] = [];
  try {
    const runtime = await runtimeLoader.load();
    const cfg = runtime.getRuntimeConfig();
    const fallback = runtime.extractDeliveryInfo(sessionKey, { cfg });
    const fallbackDelivery =
      fallback.deliveryContext && fallback.threadId != null
        ? { ...fallback.deliveryContext, threadId: fallback.threadId }
        : fallback.deliveryContext;
    const batch = selectSystemEventBatch({
      events,
      fallbackRoute: {
        delivery: fallbackDelivery,
        chatType: fallback.chatType,
        senderId: fallback.senderId,
      },
    });
    if (!batch) {
      return { status: "skipped", reason: "no-events" };
    }
    claimedEvents = consumeSelectedSystemEventEntries(sessionKey, batch.events);
    if (claimedEvents.length === 0) {
      return { status: "skipped", reason: "no-events" };
    }
    const delivery = batch.route.delivery;
    const chatType =
      batch.route.chatType ??
      (delivery?.channel && delivery.to
        ? runtime.inferOutboundTargetChatType({ channel: delivery.channel, to: delivery.to })
        : undefined);
    const hasDeliveryTarget = Boolean(delivery?.channel && delivery.to);
    log.info("system event turn starting", {
      reason: params.reason,
      sessionKey,
      eventCount: claimedEvents.length,
      hasDeliveryTarget,
      channel: delivery?.channel,
    });

    params.abortSignal?.throwIfAborted();
    const result = await runtime.dispatchInboundMessageWithDispatcher({
      ctx: buildSystemEventContext({
        sessionKey,
        events: claimedEvents,
        delivery,
        chatType,
        senderId: batch.route.senderId,
      }),
      cfg,
      dispatcherOptions: {
        deliver: async (_payload, info) => {
          log.info("system event turn produced an unrouted reply", {
            reason: params.reason,
            sessionKey,
            kind: info.kind,
          });
        },
      },
      replyOptions: {
        abortSignal: params.abortSignal,
        isHeartbeat: false,
        suppressSystemEventDrain: true,
        typingPolicy: "system_event",
        suppressTyping: true,
      },
    });
    if (hasSystemEventDeliveryFailure(result)) {
      throw new Error("system event reply delivery failed");
    }
    log.info("system event turn completed", {
      reason: params.reason,
      sessionKey,
      eventCount: claimedEvents.length,
      hasDeliveryTarget,
      counts: result.counts,
      failedCounts: result.failedCounts,
    });
    return {
      status: "ran",
      eventCount: claimedEvents.length,
      hasDeliveryTarget,
      counts: result.counts,
    };
  } catch (error) {
    restoreSystemEventEntries(sessionKey, claimedEvents);
    log.warn("system event turn failed", {
      reason: params.reason,
      sessionKey,
      error: String(error),
    });
    throw new SystemEventTurnAttemptError(error, claimedEvents.length > 0 ? claimedEvents : events);
  }
}

/** Runs one non-heartbeat agent turn for the pending events of an explicit session. */
export async function runSystemEventTurn(
  params: RunSystemEventTurnParams,
): Promise<SystemEventTurnResult> {
  return await runSystemEventTurnAttempt(params);
}

function finishPendingSystemEventTurn(sessionKey: string): void {
  pendingTurns.delete(sessionKey);
}

function scheduleSystemEventTurn(
  sessionKey: string,
  pending: PendingSystemEventTurn,
  delayMs: number,
): void {
  const timer = setTimeout(() => {
    pending.running = true;
    const reason = pending.reason;
    let failed = false;
    let attemptError: unknown;
    void runSystemEventTurnAttempt({ sessionKey, reason }, pending.retryEvents)
      .then(() => {
        pending.failedAttempts = 0;
        pending.retryEvents = undefined;
      })
      .catch((error: unknown) => {
        failed = true;
        attemptError = error;
        pending.failedAttempts += 1;
        if (error instanceof SystemEventTurnAttemptError) {
          pending.retryEvents ??= error.events;
        }
      })
      .finally(() => {
        pending.running = false;
        if (failed && pending.failedAttempts <= MAX_RETRY_ATTEMPTS) {
          pending.rerunRequested = false;
          const retryMs = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** (pending.failedAttempts - 1));
          log.warn("system event turn will retry after failure", {
            reason: pending.reason,
            sessionKey,
            attempt: pending.failedAttempts,
            retryMs,
          });
          scheduleSystemEventTurn(sessionKey, pending, retryMs);
          return;
        }
        if (failed) {
          const exhaustedEvents =
            attemptError instanceof SystemEventTurnAttemptError
              ? attemptError.events
              : (pending.retryEvents ?? []);
          const dropped = consumeSelectedSystemEventEntries(sessionKey, exhaustedEvents);
          log.warn("system event turn exhausted retries", {
            reason: pending.reason,
            sessionKey,
            attempts: pending.failedAttempts,
            droppedEventCount: dropped.length,
          });
          pending.failedAttempts = 0;
          pending.retryEvents = undefined;
          pending.rerunRequested = false;
          if (hasRunnableSystemEvents(sessionKey)) {
            scheduleSystemEventTurn(sessionKey, pending, pending.coalesceMs);
            return;
          }
          finishPendingSystemEventTurn(sessionKey);
          return;
        }
        if (pending.rerunRequested || hasRunnableSystemEvents(sessionKey)) {
          pending.rerunRequested = false;
          scheduleSystemEventTurn(sessionKey, pending, pending.coalesceMs);
          return;
        }
        finishPendingSystemEventTurn(sessionKey);
      });
  }, delayMs);
  timer.unref?.();
}

/** Coalesces event-driven turns per session while preserving requests that arrive mid-run. */
export function requestSystemEventTurn(params: {
  sessionKey: string;
  reason?: string;
  coalesceMs?: number;
}): void {
  const sessionKey = params.sessionKey.trim();
  if (!sessionKey) {
    throw new Error("system event turns require a sessionKey");
  }
  const existing = pendingTurns.get(sessionKey);
  if (existing) {
    existing.reason = params.reason ?? existing.reason;
    if (existing.running) {
      existing.rerunRequested = true;
    }
    log.debug("system event turn coalesced", {
      reason: existing.reason,
      sessionKey,
      running: existing.running,
    });
    return;
  }

  const pending: PendingSystemEventTurn = {
    reason: params.reason,
    coalesceMs: params.coalesceMs ?? DEFAULT_COALESCE_MS,
    running: false,
    rerunRequested: false,
    failedAttempts: 0,
  };
  pendingTurns.set(sessionKey, pending);
  scheduleSystemEventTurn(sessionKey, pending, pending.coalesceMs);
}
