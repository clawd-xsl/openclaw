import { getReplyFromConfig } from "../auto-reply/reply.js";
import type { MsgContext } from "../auto-reply/templating.js";
/**
 * Trigger a plain agent turn on the main session to process pending system
 * events (hook results).  Unlike `requestHeartbeatNow`, this does NOT go
 * through the heartbeat runner – it enqueues a lightweight agent turn on
 * CommandLane.Main that picks up queued system events without heartbeat
 * prompt framing or heartbeat-side delivery.
 */
import { loadConfig } from "../config/config.js";
import { resolveMainSessionKeyFromConfig } from "../config/sessions.js";
import { enqueueCommandInLane } from "../process/command-queue.js";
import { getQueueSize } from "../process/command-queue.js";
import { CommandLane } from "../process/lanes.js";

const DEFAULT_COALESCE_MS = 300;

let pendingTimer: NodeJS.Timeout | null = null;
let pendingReason: string | undefined;

function runTurn(_reason?: string): void {
  void enqueueCommandInLane(
    CommandLane.Main,
    async () => {
      const queueSize = getQueueSize(CommandLane.Main);
      // If there are other tasks queued ahead, skip – they will drain the
      // system events themselves during their session-update phase.
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

      // Run a plain agent turn.  System events (hook results) will be
      // drained and injected automatically by session-updates during the
      // agent turn.  We intentionally discard the reply – the model is
      // expected to use the `message` tool to deliver results to the user.
      await getReplyFromConfig(ctx, { isHeartbeat: false }, cfg);
    },
    {
      warnAfterMs: 10_000,
    },
  ).catch(() => {
    // Silently ignore queue errors (e.g. gateway draining).
  });
}

/**
 * Request a plain agent turn on the main session to process pending hook
 * system events.  Calls are coalesced within a short window so multiple
 * near-simultaneous hook completions result in a single agent turn.
 */
export function requestHookAgentTurn(opts?: { reason?: string; coalesceMs?: number }): void {
  pendingReason = opts?.reason ?? pendingReason;
  const delay = opts?.coalesceMs ?? DEFAULT_COALESCE_MS;

  if (pendingTimer) {
    return; // Already scheduled – coalesce.
  }

  pendingTimer = setTimeout(() => {
    pendingTimer = null;
    const reason = pendingReason;
    pendingReason = undefined;
    runTurn(reason);
  }, delay);
  pendingTimer.unref?.();
}
