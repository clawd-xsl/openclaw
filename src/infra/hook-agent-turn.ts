import { getReplyFromConfig } from "../auto-reply/reply.js";
import type { MsgContext } from "../auto-reply/templating.js";
import { loadConfig } from "../config/config.js";
import { resolveMainSessionKeyFromConfig } from "../config/sessions.js";
import { enqueueCommandInLane, getQueueSize } from "../process/command-queue.js";
import { CommandLane } from "../process/lanes.js";

const DEFAULT_COALESCE_MS = 300;

let pendingTimer: NodeJS.Timeout | null = null;
let pendingReason: string | undefined;

function runTurn(_reason?: string): void {
  void enqueueCommandInLane(
    CommandLane.Main,
    async () => {
      const queueSize = getQueueSize(CommandLane.Main);
      // Let already-queued work drain pending hook system events instead of
      // forcing an extra synthetic turn on top of it.
      if (queueSize > 1) {
        return;
      }

      const cfg = loadConfig();
      const sessionKey = resolveMainSessionKeyFromConfig();
      const ctx: MsgContext = {
        Body: "[hook event: process pending system events]",
        Provider: "hook-event",
        SessionKey: sessionKey,
        CommandAuthorized: true,
      };

      await getReplyFromConfig(ctx, { isHeartbeat: false }, cfg);
    },
    {
      warnAfterMs: 10_000,
    },
  ).catch(() => {
    // Best-effort: drop wake requests while the gateway is draining or if the
    // synthetic agent turn fails.
  });
}

export function requestHookAgentTurn(opts?: {
  reason?: string;
  coalesceMs?: number;
}): void {
  pendingReason = opts?.reason ?? pendingReason;
  const delay = opts?.coalesceMs ?? DEFAULT_COALESCE_MS;

  if (pendingTimer) {
    return;
  }

  pendingTimer = setTimeout(() => {
    pendingTimer = null;
    const reason = pendingReason;
    pendingReason = undefined;
    runTurn(reason);
  }, delay);
  pendingTimer.unref?.();
}
