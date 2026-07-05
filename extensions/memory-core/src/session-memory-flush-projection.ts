// Memory Core plugin module projects persisted flush candidates exactly once.
import { createHash } from "node:crypto";
import path from "node:path";
import { createAsyncLock } from "openclaw/plugin-sdk/async-lock-runtime";
import { root } from "openclaw/plugin-sdk/file-access-runtime";
import { withFileLock, type FileLockOptions } from "openclaw/plugin-sdk/file-lock";
import { resolveGlobalSingleton } from "openclaw/plugin-sdk/global-singleton";
import { ensureAbsoluteDirectory } from "openclaw/plugin-sdk/security-runtime";
import { SESSION_MEMORY_FLUSH_MARKER_TOKEN } from "./session-memory-flush-prompt.js";
import {
  isCanonicalSessionMemoryFlushPath,
  type SessionMemoryFlushCandidate,
  type SessionMemoryFlushTerminalCode,
} from "./session-memory-flush-store.js";

export const SESSION_MEMORY_FLUSH_PROJECTION_MAX_BYTES = 16 * 1024 * 1024;

const PROJECTION_LOCK_OPTIONS: FileLockOptions = {
  retries: {
    retries: 40,
    factor: 1.35,
    minTimeout: 25,
    maxTimeout: 500,
    randomize: true,
  },
  stale: 45 * 60 * 1_000,
};

const projectionProcessLocks = resolveGlobalSingleton(
  Symbol.for("openclaw.memoryCore.sessionMemoryFlush.projectionLocks"),
  () => new Map<string, { lock: ReturnType<typeof createAsyncLock>; references: number }>(),
);

export class SessionMemoryFlushProjectionError extends Error {
  readonly code: SessionMemoryFlushTerminalCode;

  constructor(code: SessionMemoryFlushTerminalCode, message: string) {
    super(message);
    this.name = "SessionMemoryFlushProjectionError";
    this.code = code;
  }
}

type ProjectionTarget = {
  lockDir: string;
  relativePath: string;
  workspaceDir: string;
  workspaceFingerprint: string;
};

async function withProjectionProcessLock<T>(key: string, task: () => Promise<T>): Promise<T> {
  let entry = projectionProcessLocks.get(key);
  if (!entry) {
    entry = { lock: createAsyncLock(), references: 0 };
    projectionProcessLocks.set(key, entry);
  }
  entry.references += 1;
  try {
    return await entry.lock(task);
  } finally {
    entry.references -= 1;
    if (entry.references === 0) {
      projectionProcessLocks.delete(key);
    }
  }
}

async function withProjectionTargetLock<T>(
  params: ProjectionTarget,
  task: () => Promise<T>,
): Promise<T> {
  if (!isCanonicalSessionMemoryFlushPath(params.relativePath)) {
    throw new Error("session memory flush projection requires memory/YYYY-MM-DD.md");
  }
  if (!/^[a-f0-9]{64}$/u.test(params.workspaceFingerprint)) {
    throw new Error("session memory flush projection requires a workspace fingerprint");
  }
  const lockKey = createHash("sha256")
    .update(`${params.workspaceFingerprint}\0${params.relativePath}`)
    .digest("hex");
  return await withProjectionProcessLock(lockKey, async () => {
    const ensuredLockDir = await ensureAbsoluteDirectory(params.lockDir, {
      scopeLabel: "completed-session memory-flush projection lock directory",
      mode: 0o700,
    });
    if (!ensuredLockDir.ok) {
      throw ensuredLockDir.error;
    }
    const lockTarget = path.join(ensuredLockDir.path, `${lockKey}.target`);
    return await withFileLock(lockTarget, PROJECTION_LOCK_OPTIONS, task);
  });
}

export async function withSessionMemoryFlushProjectionLock<T>(
  params: ProjectionTarget,
  task: () => Promise<T>,
): Promise<T> {
  return await withProjectionTargetLock(params, task);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function hashContent(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function startMarker(operationId: string, sha256: string): string {
  return `<!-- ${SESSION_MEMORY_FLUSH_MARKER_TOKEN} op=${operationId} sha256=${sha256} -->`;
}

function endMarker(operationId: string): string {
  return `<!-- /${SESSION_MEMORY_FLUSH_MARKER_TOKEN} op=${operationId} -->`;
}

function inspectExistingProjection(params: {
  candidate: Extract<SessionMemoryFlushCandidate, { kind: "append" }>;
  operationId: string;
  text: string;
}): "absent" | "complete" {
  const escapedOperationId = escapeRegExp(params.operationId);
  const startPattern = new RegExp(
    `<!-- ${SESSION_MEMORY_FLUSH_MARKER_TOKEN} op=${escapedOperationId} sha256=([a-f0-9]{64}) -->`,
    "gu",
  );
  const starts = [...params.text.matchAll(startPattern)];
  const end = endMarker(params.operationId);
  const endIndexes: number[] = [];
  let fromIndex = 0;
  while (true) {
    const index = params.text.indexOf(end, fromIndex);
    if (index < 0) {
      break;
    }
    endIndexes.push(index);
    fromIndex = index + end.length;
  }
  const operationPrefix = `<!-- ${SESSION_MEMORY_FLUSH_MARKER_TOKEN} op=${params.operationId}`;
  if (starts.length === 0 && endIndexes.length === 0) {
    if (params.text.includes(operationPrefix)) {
      throw new SessionMemoryFlushProjectionError(
        "marker_hash_conflict",
        "existing memory projection marker is malformed",
      );
    }
    return "absent";
  }
  if (starts.length !== 1 || endIndexes.length !== 1) {
    throw new SessionMemoryFlushProjectionError(
      starts.length > 0 && endIndexes.length === 0 ? "partial_marker" : "marker_hash_conflict",
      "existing memory projection has incomplete or duplicate operation markers",
    );
  }
  const start = starts[0];
  const startIndex = start?.index;
  const markerHash = start?.[1];
  const endIndex = endIndexes[0];
  if (startIndex === undefined || endIndex === undefined || !markerHash) {
    throw new SessionMemoryFlushProjectionError(
      "partial_marker",
      "existing memory projection markers could not be parsed",
    );
  }
  if (markerHash !== params.candidate.sha256) {
    throw new SessionMemoryFlushProjectionError(
      "marker_hash_conflict",
      "existing memory projection operation has a different candidate hash",
    );
  }
  const contentStart = startIndex + start[0].length;
  if (endIndex <= contentStart) {
    throw new SessionMemoryFlushProjectionError(
      "partial_marker",
      "existing memory projection start marker has no matching end marker",
    );
  }
  const projectedContent = params.text
    .slice(contentStart, endIndex)
    .replace(/^\r?\n/u, "")
    .replace(/\r?\n$/u, "");
  if (hashContent(projectedContent) !== params.candidate.sha256) {
    throw new SessionMemoryFlushProjectionError(
      "marker_hash_conflict",
      "existing memory projection content does not match its candidate hash",
    );
  }
  return "complete";
}

export async function projectSessionMemoryFlushCandidate(
  params: ProjectionTarget & {
    candidate: Extract<SessionMemoryFlushCandidate, { kind: "append" }>;
    operationId: string;
    shouldProject?: () => boolean | Promise<boolean>;
    validateTarget?: () => Promise<void> | void;
  },
): Promise<"appended" | "cancelled" | "reconciled"> {
  return await withProjectionTargetLock(params, async () => {
    const workspace = await root(params.workspaceDir, {
      hardlinks: "reject",
      maxBytes: SESSION_MEMORY_FLUSH_PROJECTION_MAX_BYTES,
      symlinks: "reject",
    });
    // Revalidate the persisted workspace identity after taking the target lock.
    // This rejects config changes and replacements that happened before the
    // critical section; fs-safe still guards the path-based append itself.
    await params.validateTarget?.();
    // Purge takes this same target lock before deleting the durable outbox record.
    // Re-checking under the lock prevents a worker that was already in flight from
    // appending after deletion has completed, including across plugin processes.
    if (params.shouldProject && !(await params.shouldProject())) {
      return "cancelled";
    }
    const existing = (await workspace.exists(params.relativePath))
      ? await workspace.readText(params.relativePath, {
          maxBytes: SESSION_MEMORY_FLUSH_PROJECTION_MAX_BYTES,
        })
      : "";
    if (
      inspectExistingProjection({
        candidate: params.candidate,
        operationId: params.operationId,
        text: existing,
      }) === "complete"
    ) {
      return "reconciled";
    }
    const block = [
      startMarker(params.operationId, params.candidate.sha256),
      params.candidate.content,
      endMarker(params.operationId),
      "",
    ].join("\n");
    const separator = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
    const projectedBytes =
      Buffer.byteLength(existing, "utf8") + Buffer.byteLength(separator + block);
    if (projectedBytes > SESSION_MEMORY_FLUSH_PROJECTION_MAX_BYTES) {
      throw new Error(
        `session memory flush projection would exceed ${SESSION_MEMORY_FLUSH_PROJECTION_MAX_BYTES} bytes`,
      );
    }
    // Catch a workspace replacement that raced the bounded read before the
    // path-based append. The stable state-directory lock still serializes every
    // cooperating projector and purge even if the workspace path is replaced.
    await params.validateTarget?.();
    if (params.shouldProject && !(await params.shouldProject())) {
      return "cancelled";
    }
    await workspace.append(params.relativePath, block, {
      mkdir: true,
      mode: 0o600,
      prependNewlineIfNeeded: true,
    });
    return "appended";
  });
}
