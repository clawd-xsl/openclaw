import { resolveGlobalSingleton } from "../../shared/global-singleton.js";
import { normalizeOptionalString } from "../../shared/string-coerce.js";

export type ReplyRunKey = string;

export type ReplyBackendKind = "embedded" | "cli";

export type ReplyBackendCancelReason = "user_abort" | "restart" | "superseded";

export type ReplyBackendHandle = {
  readonly kind: ReplyBackendKind;
  cancel(reason?: ReplyBackendCancelReason): void;
  isStreaming(): boolean;
  queueMessage?: (text: string) => Promise<void>;
  /**
   * Compatibility-only hook so legacy "abort compacting runs" paths can still
   * find embedded runs that are compacting during the main run phase.
   */
  isCompacting?: () => boolean;
};

export type ReplyOperationPhase =
  | "queued"
  | "preflight_compacting"
  | "memory_flushing"
  | "running"
  | "completed"
  | "failed"
  | "aborted";

export type ReplyOperationFailureCode =
  | "gateway_draining"
  | "command_lane_cleared"
  | "aborted_by_user"
  | "session_corruption_reset"
  | "run_failed";

export type ReplyOperationAbortCode = "aborted_by_user" | "aborted_for_restart";

export type ReplyOperationResult =
  | { kind: "completed" }
  | { kind: "failed"; code: ReplyOperationFailureCode; cause?: unknown }
  | { kind: "aborted"; code: ReplyOperationAbortCode };

export type ReplyOperation = {
  readonly key: ReplyRunKey;
  readonly sessionId: string;
  readonly abortSignal: AbortSignal;
  readonly resetTriggered: boolean;
  readonly phase: ReplyOperationPhase;
  readonly result: ReplyOperationResult | null;
  setPhase(next: "queued" | "preflight_compacting" | "memory_flushing" | "running"): void;
  updateSessionId(nextSessionId: string): void;
  attachBackend(handle: ReplyBackendHandle): void;
  detachBackend(handle: ReplyBackendHandle): void;
  complete(): void;
  fail(code: Exclude<ReplyOperationFailureCode, "aborted_by_user">, cause?: unknown): void;
  abortByUser(): void;
  abortForRestart(): void;
};

export type ReplyRunRegistry = {
  begin(params: {
    sessionKey: string;
    sessionId: string;
    resetTriggered: boolean;
    upstreamAbortSignal?: AbortSignal;
  }): ReplyOperation;
  get(sessionKey: string): ReplyOperation | undefined;
  isActive(sessionKey: string): boolean;
  isStreaming(sessionKey: string): boolean;
  abort(sessionKey: string): boolean;
  waitForIdle(sessionKey: string, timeoutMs?: number): Promise<boolean>;
  resolveSessionId(sessionKey: string): string | undefined;
};

type ReplyRunWaiter = {
  resolve: (ended: boolean) => void;
  timer: NodeJS.Timeout;
};

type ReplyRunState = {
  activeRunsByKey: Map<string, ReplyOperation>;
  activeSessionIdsByKey: Map<string, string>;
  activeOpsBySessionId: Map<string, ReplyOperation>;
  waitOpsBySessionId: Map<string, ReplyOperation>;
  waitersByKey: Map<string, Set<ReplyRunWaiter>>;
};

const REPLY_RUN_STATE_KEY = Symbol.for("openclaw.replyRunRegistry");

const replyRunState = resolveGlobalSingleton<ReplyRunState>(REPLY_RUN_STATE_KEY, () => ({
  activeRunsByKey: new Map<string, ReplyOperation>(),
  activeSessionIdsByKey: new Map<string, string>(),
  activeOpsBySessionId: new Map<string, ReplyOperation>(),
  waitOpsBySessionId: new Map<string, ReplyOperation>(),
  waitersByKey: new Map<string, Set<ReplyRunWaiter>>(),
}));

export class ReplyRunAlreadyActiveError extends Error {
  constructor(sessionKey: string) {
    super(`Reply run already active for ${sessionKey}`);
    this.name = "ReplyRunAlreadyActiveError";
  }
}

function createUserAbortError(): Error {
  const err = new Error("Reply operation aborted by user");
  err.name = "AbortError";
  return err;
}

function notifyReplyRunEnded(sessionKey: string): void {
  const waiters = replyRunState.waitersByKey.get(sessionKey);
  if (!waiters || waiters.size === 0) {
    return;
  }
  replyRunState.waitersByKey.delete(sessionKey);
  for (const waiter of waiters) {
    clearTimeout(waiter.timer);
    waiter.resolve(true);
  }
}

function resolveReplyRunForCurrentSessionId(sessionId: string): ReplyOperation | undefined {
  const normalizedSessionId = normalizeOptionalString(sessionId);
  if (!normalizedSessionId) {
    return undefined;
  }
  return replyRunState.activeOpsBySessionId.get(normalizedSessionId);
}

function isReplyRunBlocking(operation: ReplyOperation | undefined): boolean {
  return operation !== undefined && operation.result == null;
}

function resolveReplyRunWaitKey(sessionId: string): string | undefined {
  const normalizedSessionId = normalizeOptionalString(sessionId);
  if (!normalizedSessionId) {
    return undefined;
  }
  return (
    replyRunState.activeOpsBySessionId.get(normalizedSessionId)?.key ??
    replyRunState.waitOpsBySessionId.get(normalizedSessionId)?.key
  );
}

function isReplyRunCompacting(operation: ReplyOperation): boolean {
  if (operation.phase === "preflight_compacting" || operation.phase === "memory_flushing") {
    return true;
  }
  if (operation.phase !== "running") {
    return false;
  }
  const backend = getAttachedBackend(operation);
  return backend?.isCompacting?.() ?? false;
}

const attachedBackendByOperation = new WeakMap<ReplyOperation, ReplyBackendHandle>();

function getAttachedBackend(operation: ReplyOperation): ReplyBackendHandle | undefined {
  return attachedBackendByOperation.get(operation);
}

function clearReplyRunState(params: {
  sessionKey: string;
  sessionId: string;
  operation: ReplyOperation;
  ownedSessionIds: Iterable<string>;
}): void {
  const isCurrentActiveOperation =
    replyRunState.activeRunsByKey.get(params.sessionKey) === params.operation;
  if (isCurrentActiveOperation) {
    replyRunState.activeRunsByKey.delete(params.sessionKey);
    replyRunState.activeSessionIdsByKey.delete(params.sessionKey);
  }
  for (const ownedSessionId of params.ownedSessionIds) {
    if (replyRunState.activeOpsBySessionId.get(ownedSessionId) === params.operation) {
      replyRunState.activeOpsBySessionId.delete(ownedSessionId);
    }
    if (replyRunState.waitOpsBySessionId.get(ownedSessionId) === params.operation) {
      replyRunState.waitOpsBySessionId.delete(ownedSessionId);
    }
  }
  if (isCurrentActiveOperation) {
    notifyReplyRunEnded(params.sessionKey);
  }
}

export function createReplyOperation(params: {
  sessionKey: string;
  sessionId: string;
  resetTriggered: boolean;
  upstreamAbortSignal?: AbortSignal;
}): ReplyOperation {
  const sessionKey = normalizeOptionalString(params.sessionKey);
  const sessionId = normalizeOptionalString(params.sessionId);
  if (!sessionKey) {
    throw new Error("Reply operations require a canonical sessionKey");
  }
  if (!sessionId) {
    throw new Error("Reply operations require a sessionId");
  }
  const existingOperation = replyRunState.activeRunsByKey.get(sessionKey);
  if (existingOperation && existingOperation.result?.kind !== "aborted") {
    throw new ReplyRunAlreadyActiveError(sessionKey);
  }

  const controller = new AbortController();
  let currentSessionId = sessionId;
  let phase: ReplyOperationPhase = "queued";
  let result: ReplyOperationResult | null = null;
  let stateCleared = false;
  const ownedSessionIds = new Set<string>([sessionId]);

  const clearState = () => {
    if (stateCleared) {
      return;
    }
    stateCleared = true;
    clearReplyRunState({
      sessionKey,
      sessionId: currentSessionId,
      operation,
      ownedSessionIds,
    });
  };

  const abortInternally = (reason?: unknown) => {
    if (!controller.signal.aborted) {
      controller.abort(reason);
    }
  };

  const abortWithReason = (
    reason: ReplyBackendCancelReason,
    abortReason: unknown,
    opts?: { abortedCode?: ReplyOperationAbortCode },
  ) => {
    if (opts?.abortedCode && !result) {
      result = { kind: "aborted", code: opts.abortedCode };
    }
    phase = "aborted";
    abortInternally(abortReason);
    getAttachedBackend(operation)?.cancel(reason);
  };

  if (params.upstreamAbortSignal) {
    if (params.upstreamAbortSignal.aborted) {
      abortInternally(params.upstreamAbortSignal.reason);
    } else {
      params.upstreamAbortSignal.addEventListener(
        "abort",
        () => {
          abortInternally(params.upstreamAbortSignal?.reason);
        },
        { once: true },
      );
    }
  }

  const operation: ReplyOperation = {
    get key() {
      return sessionKey;
    },
    get sessionId() {
      return currentSessionId;
    },
    get abortSignal() {
      return controller.signal;
    },
    get resetTriggered() {
      return params.resetTriggered;
    },
    get phase() {
      return phase;
    },
    get result() {
      return result;
    },
    setPhase(next) {
      if (result) {
        return;
      }
      phase = next;
    },
    updateSessionId(nextSessionId) {
      if (result) {
        return;
      }
      const normalizedNextSessionId = normalizeOptionalString(nextSessionId);
      if (!normalizedNextSessionId || normalizedNextSessionId === currentSessionId) {
        return;
      }
      if (
        replyRunState.activeOpsBySessionId.has(normalizedNextSessionId) &&
        replyRunState.activeOpsBySessionId.get(normalizedNextSessionId) !== operation
      ) {
        throw new Error(
          `Cannot rebind reply operation ${sessionKey} to active session ${normalizedNextSessionId}`,
        );
      }
      if (replyRunState.activeOpsBySessionId.get(currentSessionId) === operation) {
        replyRunState.activeOpsBySessionId.delete(currentSessionId);
      }
      replyRunState.waitOpsBySessionId.set(currentSessionId, operation);
      currentSessionId = normalizedNextSessionId;
      ownedSessionIds.add(currentSessionId);
      replyRunState.activeSessionIdsByKey.set(sessionKey, currentSessionId);
      replyRunState.activeOpsBySessionId.set(currentSessionId, operation);
      replyRunState.waitOpsBySessionId.set(currentSessionId, operation);
    },
    attachBackend(handle) {
      if (result) {
        handle.cancel(
          result.kind === "aborted"
            ? result.code === "aborted_for_restart"
              ? "restart"
              : "user_abort"
            : "superseded",
        );
        return;
      }
      attachedBackendByOperation.set(operation, handle);
      if (controller.signal.aborted) {
        handle.cancel("superseded");
      }
    },
    detachBackend(handle) {
      if (getAttachedBackend(operation) === handle) {
        attachedBackendByOperation.delete(operation);
      }
    },
    complete() {
      if (!result) {
        result = { kind: "completed" };
        phase = "completed";
      }
      clearState();
    },
    fail(code, cause) {
      if (!result) {
        result = { kind: "failed", code, cause };
        phase = "failed";
      }
      clearState();
    },
    abortByUser() {
      const phaseBeforeAbort = phase;
      abortWithReason("user_abort", createUserAbortError(), {
        abortedCode: "aborted_by_user",
      });
      if (phaseBeforeAbort === "queued") {
        clearState();
      }
    },
    abortForRestart() {
      const phaseBeforeAbort = phase;
      abortWithReason("restart", new Error("Reply operation aborted for restart"), {
        abortedCode: "aborted_for_restart",
      });
      if (phaseBeforeAbort === "queued") {
        clearState();
      }
    },
  };

  replyRunState.activeRunsByKey.set(sessionKey, operation);
  replyRunState.activeSessionIdsByKey.set(sessionKey, currentSessionId);
  replyRunState.activeOpsBySessionId.set(currentSessionId, operation);
  replyRunState.waitOpsBySessionId.set(currentSessionId, operation);

  return operation;
}

export const replyRunRegistry: ReplyRunRegistry = {
  begin(params) {
    return createReplyOperation(params);
  },
  get(sessionKey) {
    const normalizedSessionKey = normalizeOptionalString(sessionKey);
    if (!normalizedSessionKey) {
      return undefined;
    }
    return replyRunState.activeRunsByKey.get(normalizedSessionKey);
  },
  isActive(sessionKey) {
    const normalizedSessionKey = normalizeOptionalString(sessionKey);
    if (!normalizedSessionKey) {
      return false;
    }
    return isReplyRunBlocking(replyRunState.activeRunsByKey.get(normalizedSessionKey));
  },
  isStreaming(sessionKey) {
    const operation = this.get(sessionKey);
    if (!operation || operation.phase !== "running") {
      return false;
    }
    return getAttachedBackend(operation)?.isStreaming() ?? false;
  },
  abort(sessionKey) {
    const operation = this.get(sessionKey);
    if (!operation) {
      return false;
    }
    operation.abortByUser();
    return true;
  },
  waitForIdle(sessionKey, timeoutMs = 15_000) {
    const normalizedSessionKey = normalizeOptionalString(sessionKey);
    if (!normalizedSessionKey || !replyRunState.activeRunsByKey.has(normalizedSessionKey)) {
      return Promise.resolve(true);
    }
    return new Promise((resolve) => {
      const waiters = replyRunState.waitersByKey.get(normalizedSessionKey) ?? new Set();
      const waiter: ReplyRunWaiter = {
        resolve,
        timer: setTimeout(
          () => {
            waiters.delete(waiter);
            if (waiters.size === 0) {
              replyRunState.waitersByKey.delete(normalizedSessionKey);
            }
            resolve(false);
          },
          Math.max(100, timeoutMs),
        ),
      };
      waiters.add(waiter);
      replyRunState.waitersByKey.set(normalizedSessionKey, waiters);
      if (!replyRunState.activeRunsByKey.has(normalizedSessionKey)) {
        waiters.delete(waiter);
        if (waiters.size === 0) {
          replyRunState.waitersByKey.delete(normalizedSessionKey);
        }
        clearTimeout(waiter.timer);
        resolve(true);
      }
    });
  },
  resolveSessionId(sessionKey) {
    const normalizedSessionKey = normalizeOptionalString(sessionKey);
    if (!normalizedSessionKey) {
      return undefined;
    }
    return replyRunState.activeSessionIdsByKey.get(normalizedSessionKey);
  },
};

export function resolveActiveReplyRunSessionId(sessionKey: string): string | undefined {
  const normalizedSessionKey = normalizeOptionalString(sessionKey);
  if (!normalizedSessionKey) {
    return undefined;
  }
  const operation = replyRunState.activeRunsByKey.get(normalizedSessionKey);
  if (!isReplyRunBlocking(operation)) {
    return undefined;
  }
  return replyRunState.activeSessionIdsByKey.get(normalizedSessionKey);
}

export function isReplyRunActiveForSessionId(sessionId: string): boolean {
  return isReplyRunBlocking(resolveReplyRunForCurrentSessionId(sessionId));
}

export function isReplyRunStreamingForSessionId(sessionId: string): boolean {
  const operation = resolveReplyRunForCurrentSessionId(sessionId);
  if (!operation || operation.phase !== "running") {
    return false;
  }
  return getAttachedBackend(operation)?.isStreaming() ?? false;
}

export function queueReplyRunMessage(sessionId: string, text: string): boolean {
  const operation = resolveReplyRunForCurrentSessionId(sessionId);
  const backend = operation ? getAttachedBackend(operation) : undefined;
  if (!operation || operation.phase !== "running" || !backend?.queueMessage) {
    return false;
  }
  if (!backend.isStreaming()) {
    return false;
  }
  void backend.queueMessage(text);
  return true;
}

export function abortReplyRunBySessionId(sessionId: string): boolean {
  const operation = resolveReplyRunForCurrentSessionId(sessionId);
  if (!operation) {
    return false;
  }
  operation.abortByUser();
  return true;
}

export function waitForReplyRunEndBySessionId(
  sessionId: string,
  timeoutMs = 15_000,
): Promise<boolean> {
  const waitKey = resolveReplyRunWaitKey(sessionId);
  if (!waitKey) {
    return Promise.resolve(true);
  }
  return replyRunRegistry.waitForIdle(waitKey, timeoutMs);
}

export function abortActiveReplyRuns(opts: { mode: "all" | "compacting" }): boolean {
  let aborted = false;
  for (const operation of replyRunState.activeRunsByKey.values()) {
    if (opts.mode === "compacting" && !isReplyRunCompacting(operation)) {
      continue;
    }
    operation.abortForRestart();
    aborted = true;
  }
  return aborted;
}

export function getActiveReplyRunCount(): number {
  return replyRunState.activeRunsByKey.size;
}

export function listActiveReplyRunSessionIds(): string[] {
  return [...replyRunState.activeRunsByKey.entries()]
    .filter(([, operation]) => isReplyRunBlocking(operation))
    .map(([sessionKey]) => replyRunState.activeSessionIdsByKey.get(sessionKey))
    .filter((sessionId): sessionId is string => Boolean(sessionId));
}

export const __testing = {
  resetReplyRunRegistry(): void {
    replyRunState.activeRunsByKey.clear();
    replyRunState.activeSessionIdsByKey.clear();
    replyRunState.activeOpsBySessionId.clear();
    replyRunState.waitOpsBySessionId.clear();
    for (const waiters of replyRunState.waitersByKey.values()) {
      for (const waiter of waiters) {
        clearTimeout(waiter.timer);
        waiter.resolve(false);
      }
    }
    replyRunState.waitersByKey.clear();
  },
};
