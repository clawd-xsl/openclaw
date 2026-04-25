import { getReplyFromConfig } from "../auto-reply/reply.js";
import { routeReply } from "../auto-reply/reply/route-reply.js";
import type { MsgContext } from "../auto-reply/templating.js";
import type { ReplyPayload } from "../auto-reply/types.js";
import { loadConfig } from "../config/config.js";
import { resolveMainSessionKeyFromConfig } from "../config/sessions.js";
import { extractDeliveryInfo } from "../config/sessions/delivery-info.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { enqueueCommandInLane, getQueueSize } from "../process/command-queue.js";
import { CommandLane } from "../process/lanes.js";
import { peekSystemEventEntries, resolveSystemEventDeliveryContext } from "./system-events.js";

const DEFAULT_COALESCE_MS = 300;
const log = createSubsystemLogger("hook-agent-turn");

let pendingTimer: NodeJS.Timeout | null = null;
let pendingReason: string | undefined;

function asReplyPayloadArray(
  value: ReplyPayload | ReplyPayload[] | undefined,
): readonly ReplyPayload[] {
  if (!value) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

function previewHookEventText(value: string, maxChars = 120): string {
  const singleLine = value.replace(/\s+/g, " ").trim();
  return singleLine.length > maxChars ? `${singleLine.slice(0, maxChars - 1)}…` : singleLine;
}

function runTurn(reason?: string): void {
  void enqueueCommandInLane(
    CommandLane.Main,
    async () => {
      const cfg = loadConfig();
      const sessionKey = resolveMainSessionKeyFromConfig();
      const pendingBefore = peekSystemEventEntries(sessionKey);
      const queueSize = getQueueSize(CommandLane.Main);
      // Let already-queued work drain pending hook system events instead of
      // forcing an extra synthetic turn on top of it.
      if (queueSize > 1) {
        log.info("hook trace: synthetic wake skipped because main lane already has queued work", {
          reason,
          sessionKey,
          queueSize,
          pendingEvents: pendingBefore.length,
          pendingEventPreviews: pendingBefore.map((event) => previewHookEventText(event.text)),
        });
        return;
      }

      log.info("hook trace: synthetic wake starting main turn", {
        reason,
        sessionKey,
        queueSize,
        pendingEvents: pendingBefore.length,
        pendingEventPreviews: pendingBefore.map((event) => previewHookEventText(event.text)),
      });
      const delivery =
        resolveSystemEventDeliveryContext(pendingBefore) ??
        extractDeliveryInfo(sessionKey).deliveryContext;
      const ctx: MsgContext = {
        Body: "[hook event: process pending system events]",
        ...(delivery?.to ? { From: delivery.to, To: delivery.to } : {}),
        ...(delivery?.channel
          ? {
              OriginatingChannel: delivery.channel as MsgContext["OriginatingChannel"],
              OriginatingTo: delivery.to,
            }
          : {}),
        ...(delivery?.accountId ? { AccountId: delivery.accountId } : {}),
        ...(delivery?.threadId ? { MessageThreadId: delivery.threadId } : {}),
        Provider: "hook-event",
        SessionKey: sessionKey,
        CommandAuthorized: true,
      };

      try {
        const reply = await getReplyFromConfig(ctx, { isHeartbeat: false }, cfg);
        if (delivery?.channel && delivery?.to) {
          for (const payload of asReplyPayloadArray(reply)) {
            const result = await routeReply({
              payload,
              channel: delivery.channel as MsgContext["OriginatingChannel"],
              to: delivery.to,
              accountId: delivery.accountId,
              threadId: delivery.threadId,
              cfg,
              sessionKey,
            });
            if (!result.ok) {
              log.warn("hook trace: synthetic wake reply delivery failed", {
                reason,
                sessionKey,
                channel: delivery.channel,
                to: delivery.to,
                error: result.error,
              });
            }
          }
        } else if (asReplyPayloadArray(reply).length > 0) {
          log.info("hook trace: synthetic wake produced reply payloads without a delivery target", {
            reason,
            sessionKey,
            payloadCount: asReplyPayloadArray(reply).length,
          });
        }
        const pendingAfter = peekSystemEventEntries(sessionKey);
        log.info("hook trace: synthetic wake completed", {
          reason,
          sessionKey,
          remainingPendingEvents: pendingAfter.length,
          remainingEventPreviews: pendingAfter.map((event) => previewHookEventText(event.text)),
        });
      } catch (err) {
        log.warn("hook trace: synthetic wake failed", {
          reason,
          sessionKey,
          error: String(err),
        });
        throw err;
      }
    },
    {
      warnAfterMs: 10_000,
    },
  ).catch(() => {
    // Best-effort: drop wake requests while the gateway is draining or if the
    // synthetic agent turn fails.
  });
}

export function requestHookAgentTurn(opts?: { reason?: string; coalesceMs?: number }): void {
  pendingReason = opts?.reason ?? pendingReason;
  const delay = opts?.coalesceMs ?? DEFAULT_COALESCE_MS;

  if (pendingTimer) {
    log.info("hook trace: synthetic wake coalesced", {
      reason: pendingReason,
      delayMs: delay,
    });
    return;
  }

  log.info("hook trace: synthetic wake scheduled", {
    reason: pendingReason,
    delayMs: delay,
  });
  pendingTimer = setTimeout(() => {
    pendingTimer = null;
    const reason = pendingReason;
    pendingReason = undefined;
    log.info("hook trace: synthetic wake timer fired", {
      reason,
    });
    runTurn(reason);
  }, delay);
  pendingTimer.unref?.();
}
