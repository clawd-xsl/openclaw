import { createTypingKeepaliveLoop } from "./typing-lifecycle.js";
import { createTypingStartGuard } from "./typing-start-guard.js";

export type TypingCallbacks = {
  onReplyStart: () => Promise<void>;
  onIdle?: () => void;
  /** Called when the typing controller is cleaned up (e.g. on NO_REPLY). */
  onCleanup?: () => void;
};

export type CreateTypingCallbacksParams = {
  start: () => Promise<void>;
  stop?: () => Promise<void>;
  onStartError: (err: unknown) => void;
  onStopError?: (err: unknown) => void;
  keepaliveIntervalMs?: number;
  /** Stop keepalive after this many consecutive start() failures. Default: 2 */
  maxConsecutiveFailures?: number;
  /**
   * Maximum inactivity window for typing keepalive before auto-cleanup.
   * Each successful typing keepalive refreshes this TTL. Default: 60s.
   */
  maxDurationMs?: number;
};

export function createTypingCallbacks(params: CreateTypingCallbacksParams): TypingCallbacks {
  const stop = params.stop;
  const keepaliveIntervalMs = params.keepaliveIntervalMs ?? 3_000;
  const maxConsecutiveFailures = Math.max(1, params.maxConsecutiveFailures ?? 2);
  const maxDurationMs = params.maxDurationMs ?? 60_000; // Default 60s TTL
  let stopSent = false;
  let closed = false;
  let ttlTimer: ReturnType<typeof setTimeout> | undefined;

  const startGuard = createTypingStartGuard({
    isSealed: () => closed,
    onStartError: params.onStartError,
    maxConsecutiveFailures,
    onTrip: () => {
      keepaliveLoop.stop();
    },
  });

  const fireStart = async (): Promise<void> => {
    const result = await startGuard.run(() => params.start());
    if (!closed && result === "started") {
      startTtlTimer();
    }
  };

  const keepaliveLoop = createTypingKeepaliveLoop({
    intervalMs: keepaliveIntervalMs,
    onTick: fireStart,
  });

  // TTL safety: auto-stop typing after maxDurationMs of keepalive inactivity.
  const startTtlTimer = () => {
    if (maxDurationMs <= 0) {
      return;
    }
    clearTtlTimer();
    ttlTimer = setTimeout(() => {
      if (!closed) {
        console.warn(`[typing] TTL exceeded (${maxDurationMs}ms), auto-stopping typing indicator`);
        fireStop();
      }
    }, maxDurationMs);
  };

  const clearTtlTimer = () => {
    if (ttlTimer) {
      clearTimeout(ttlTimer);
      ttlTimer = undefined;
    }
  };

  const onReplyStart = async () => {
    if (closed) {
      return;
    }
    stopSent = false;
    startGuard.reset();
    keepaliveLoop.stop();
    clearTtlTimer();
    await fireStart();
    if (startGuard.isTripped()) {
      return;
    }
    keepaliveLoop.start();
  };

  const fireStop = () => {
    closed = true;
    keepaliveLoop.stop();
    clearTtlTimer(); // Clear TTL timer on normal stop
    if (!stop || stopSent) {
      return;
    }
    stopSent = true;
    void stop().catch((err) => (params.onStopError ?? params.onStartError)(err));
  };

  return { onReplyStart, onIdle: fireStop, onCleanup: fireStop };
}
