// Memory Core plugin module projects persisted flush candidates exactly once.
import { createHash } from "node:crypto";
import { root } from "openclaw/plugin-sdk/file-access-runtime";
import { withFileLock, type FileLockOptions } from "openclaw/plugin-sdk/file-lock";
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

export class SessionMemoryFlushProjectionError extends Error {
  readonly code: SessionMemoryFlushTerminalCode;

  constructor(code: SessionMemoryFlushTerminalCode, message: string) {
    super(message);
    this.name = "SessionMemoryFlushProjectionError";
    this.code = code;
  }
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

export async function projectSessionMemoryFlushCandidate(params: {
  candidate: Extract<SessionMemoryFlushCandidate, { kind: "append" }>;
  operationId: string;
  relativePath: string;
  workspaceDir: string;
}): Promise<"appended" | "reconciled"> {
  if (!isCanonicalSessionMemoryFlushPath(params.relativePath)) {
    throw new Error("session memory flush projection requires memory/YYYY-MM-DD.md");
  }
  const workspace = await root(params.workspaceDir, {
    hardlinks: "reject",
    maxBytes: SESSION_MEMORY_FLUSH_PROJECTION_MAX_BYTES,
    symlinks: "reject",
  });
  const targetPath = await workspace.resolve(params.relativePath);
  return await withFileLock(targetPath, PROJECTION_LOCK_OPTIONS, async () => {
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
    await workspace.append(params.relativePath, block, {
      mkdir: true,
      mode: 0o600,
      prependNewlineIfNeeded: true,
    });
    return "appended";
  });
}
