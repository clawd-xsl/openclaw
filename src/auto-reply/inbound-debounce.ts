import type { OpenClawConfig } from "../config/config.js";
import type { InboundDebounceByProvider } from "../config/types.messages.js";

const resolveMs = (value: unknown): number | undefined => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  return Math.max(0, Math.trunc(value));
};

const resolveChannelOverride = (params: {
  byChannel?: InboundDebounceByProvider;
  channel: string;
}): number | undefined => {
  if (!params.byChannel) {
    return undefined;
  }
  return resolveMs(params.byChannel[params.channel]);
};

export function resolveInboundDebounceMs(params: {
  cfg: OpenClawConfig;
  channel: string;
  overrideMs?: number;
}): number {
  const inbound = params.cfg.messages?.inbound;
  const override = resolveMs(params.overrideMs);
  const byChannel = resolveChannelOverride({
    byChannel: inbound?.byChannel,
    channel: params.channel,
  });
  const base = resolveMs(inbound?.debounceMs);
  return override ?? byChannel ?? base ?? 0;
}

type DebounceBuffer<T> = {
  items: T[];
  timeout: ReturnType<typeof setTimeout> | null;
  debounceMs: number;
  flushing: boolean;
};

export type InboundDebounceCreateParams<T> = {
  debounceMs: number;
  buildKey: (item: T) => string | null | undefined;
  shouldDebounce?: (item: T) => boolean;
  resolveDebounceMs?: (item: T) => number | undefined;
  onFlush: (items: T[]) => Promise<void>;
  onError?: (err: unknown, items: T[]) => void;
};

export function createInboundDebouncer<T>(params: InboundDebounceCreateParams<T>) {
  const buffers = new Map<string, DebounceBuffer<T>>();
  const defaultDebounceMs = Math.max(0, Math.trunc(params.debounceMs));

  const resolveDebounceMs = (item: T) => {
    const resolved = params.resolveDebounceMs?.(item);
    if (typeof resolved !== "number" || !Number.isFinite(resolved)) {
      return defaultDebounceMs;
    }
    return Math.max(0, Math.trunc(resolved));
  };

  const flushBuffer = async (key: string, buffer: DebounceBuffer<T>) => {
    if (buffer.timeout) {
      clearTimeout(buffer.timeout);
      buffer.timeout = null;
    }
    if (buffer.items.length === 0) {
      buffers.delete(key);
      return;
    }

    buffer.flushing = true;
    const maxRetries = 3;
    const baseDelayMs = 1000;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      // Snapshot the current items for this flush attempt.
      const itemsToFlush = buffer.items.slice();
      try {
        await params.onFlush(itemsToFlush);
        // Success: remove only the flushed items (new ones may have been appended during the await).
        buffer.flushing = false;
        buffer.items.splice(0, itemsToFlush.length);
        if (buffer.items.length === 0) {
          buffers.delete(key);
        } else {
          // New items arrived during flush — schedule another flush for them.
          scheduleFlush(key, buffer);
        }
        return;
      } catch (err) {
        if (attempt < maxRetries) {
          // Exponential backoff: 1s, 2s, 4s
          const delay = baseDelayMs * Math.pow(2, attempt);
          await new Promise<void>((resolve) => setTimeout(resolve, delay));
          // After waiting, the buffer may have new items appended — loop will
          // re-snapshot buffer.items so the retry includes them.
          continue;
        }
        // All retries exhausted — unrecoverable.
        buffer.flushing = false;
        params.onError?.(err, buffer.items);
        buffer.items.length = 0;
        buffers.delete(key);
      }
    }
  };

  const flushKey = async (key: string) => {
    const buffer = buffers.get(key);
    if (!buffer) {
      return;
    }
    await flushBuffer(key, buffer);
  };

  const scheduleFlush = (key: string, buffer: DebounceBuffer<T>) => {
    if (buffer.timeout) {
      clearTimeout(buffer.timeout);
    }
    buffer.timeout = setTimeout(() => {
      void flushBuffer(key, buffer);
    }, buffer.debounceMs);
    buffer.timeout.unref?.();
  };

  const enqueue = async (item: T) => {
    const key = params.buildKey(item);
    const debounceMs = resolveDebounceMs(item);
    const canDebounce = debounceMs > 0 && (params.shouldDebounce?.(item) ?? true);

    if (!canDebounce || !key) {
      if (key && buffers.has(key)) {
        await flushKey(key);
      }
      try {
        await params.onFlush([item]);
      } catch (err) {
        params.onError?.(err, [item]);
      }
      return;
    }

    const existing = buffers.get(key);
    if (existing) {
      existing.items.push(item);
      existing.debounceMs = debounceMs;
      // If the buffer is currently being flushed (with retries), just append;
      // the retry loop will pick up new items on the next attempt.
      if (!existing.flushing) {
        scheduleFlush(key, existing);
      }
      return;
    }

    const buffer: DebounceBuffer<T> = { items: [item], timeout: null, debounceMs, flushing: false };
    buffers.set(key, buffer);
    scheduleFlush(key, buffer);
  };

  return { enqueue, flushKey };
}
