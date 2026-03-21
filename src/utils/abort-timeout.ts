import { bindAbortRelay } from "./fetch-timeout.js";

function toAbortError(reason?: unknown): Error {
  if (reason instanceof Error) {
    return reason;
  }
  const message = typeof reason === "string" && reason.trim() ? reason.trim() : "Aborted";
  const err = new Error(message);
  err.name = "AbortError";
  return err;
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) {
    return;
  }
  const reason =
    "reason" in signal ? (signal as AbortSignal & { reason?: unknown }).reason : undefined;
  throw toAbortError(reason);
}

export function combineAbortSignals(...signals: Array<AbortSignal | undefined>): {
  signal?: AbortSignal;
  cleanup: () => void;
} {
  const activeSignals = signals.filter((signal): signal is AbortSignal => Boolean(signal));
  if (activeSignals.length === 0) {
    return { signal: undefined, cleanup: () => {} };
  }
  if (activeSignals.length === 1) {
    return { signal: activeSignals[0], cleanup: () => {} };
  }

  const alreadyAborted = activeSignals.find((signal) => signal.aborted);
  if (alreadyAborted) {
    return { signal: alreadyAborted, cleanup: () => {} };
  }

  if (typeof AbortSignal.any === "function") {
    return { signal: AbortSignal.any(activeSignals), cleanup: () => {} };
  }

  const controller = new AbortController();
  const listeners = activeSignals.map((signal) => {
    const onAbort = bindAbortRelay(controller);
    signal.addEventListener("abort", onAbort, { once: true });
    return { signal, onAbort };
  });

  return {
    signal: controller.signal,
    cleanup: () => {
      for (const { signal, onAbort } of listeners) {
        signal.removeEventListener("abort", onAbort);
      }
    },
  };
}

export async function runWithAbortTimeout<T>(params: {
  signal?: AbortSignal;
  timeoutMs?: number;
  timeoutMessage: string;
  run: (signal?: AbortSignal) => Promise<T>;
}): Promise<T> {
  throwIfAborted(params.signal);

  const timeoutMsRaw = params.timeoutMs;
  const timeoutMs =
    typeof timeoutMsRaw === "number" && Number.isFinite(timeoutMsRaw) && timeoutMsRaw > 0
      ? Math.max(1, Math.floor(timeoutMsRaw))
      : undefined;
  if (!timeoutMs) {
    return await params.run(params.signal);
  }

  const timeoutController = new AbortController();
  const timeoutError = new Error(params.timeoutMessage);
  timeoutError.name = "TimeoutError";
  const timer = setTimeout(() => {
    timeoutController.abort(timeoutError);
  }, timeoutMs);
  const { signal, cleanup } = combineAbortSignals(params.signal, timeoutController.signal);

  try {
    throwIfAborted(signal);
    return await params.run(signal);
  } catch (err) {
    if (timeoutController.signal.aborted) {
      throw timeoutError;
    }
    throw err;
  } finally {
    clearTimeout(timer);
    cleanup();
  }
}
