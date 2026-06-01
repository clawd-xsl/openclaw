import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  acquireSessionWriteLock,
  resolveSessionLockMaxHoldFromTimeout,
} from "../../agents/session-write-lock.js";
import type { MsgContext } from "../../auto-reply/templating.js";
import { logVerbose } from "../../globals.js";
import { writeTextAtomic } from "../../infra/json-files.js";
import { createTimingTrace } from "../../infra/timing-trace.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { normalizeLowercaseStringOrEmpty } from "../../shared/string-coerce.js";
import {
  deliveryContextFromSession,
  mergeDeliveryContext,
  normalizeDeliveryContext,
  normalizeSessionDeliveryFields,
} from "../../utils/delivery-context.shared.js";
import type { DeliveryContext } from "../../utils/delivery-context.types.js";
import { getFileStatSnapshot } from "../cache-utils.js";
import { enforceSessionDiskBudget, type SessionDiskBudgetSweepResult } from "./disk-budget.js";
import { deriveSessionMetaPatch } from "./metadata.js";
import {
  dropSessionStoreObjectCache,
  getSerializedSessionStore,
  isSessionStoreCacheEnabled,
  setSerializedSessionStore,
  writeSessionStoreCache,
} from "./store-cache.js";
import {
  isHotSessionStorePath,
  projectSessionEntryToHot,
  projectSessionStoreToHot,
  resolveHotSessionStorePath,
} from "./store-hot.js";
import { loadHotSessionStore, loadSessionStore, normalizeSessionStore } from "./store-load.js";
import {
  clearSessionStoreCacheForTest,
  drainSessionStoreLockQueuesForTest,
  getSessionStoreLockQueueSizeForTest,
  LOCK_QUEUES,
  type SessionStoreLockQueue,
  type SessionStoreLockTask,
} from "./store-lock-state.js";
import {
  capEntryCount,
  getActiveSessionMaintenanceWarning,
  pruneStaleEntries,
  resolveMaintenanceConfig,
  rotateSessionFile,
  type ResolvedSessionMaintenanceConfig,
  type SessionMaintenanceWarning,
} from "./store-maintenance.js";
import {
  mergeSessionEntry,
  mergeSessionEntryPreserveActivity,
  type SessionEntry,
} from "./types.js";

export {
  clearSessionStoreCacheForTest,
  drainSessionStoreLockQueuesForTest,
  getSessionStoreLockQueueSizeForTest,
} from "./store-lock-state.js";
export { loadHotSessionStore, loadSessionStore } from "./store-load.js";

export function isSessionStoreWriteBusy(storePath: string): boolean {
  const queue = LOCK_QUEUES.get(storePath);
  const backfill = SESSION_STORE_BACKFILL_QUEUES.get(storePath);
  const queueBusy = Boolean(queue && (queue.running || queue.pending.length > 0));
  const backfillBusy = Boolean(
    backfill && (backfill.flushing || backfill.entries.size > 0 || backfill.timer),
  );
  return queueBusy || backfillBusy;
}

function getOrCreateSessionStoreBackfillQueue(storePath: string): SessionStoreBackfillQueue {
  const existing = SESSION_STORE_BACKFILL_QUEUES.get(storePath);
  if (existing) {
    return existing;
  }
  const created: SessionStoreBackfillQueue = {
    timer: null,
    flushing: false,
    entries: new Map<string, SessionEntry>(),
  };
  SESSION_STORE_BACKFILL_QUEUES.set(storePath, created);
  return created;
}

const log = createSubsystemLogger("sessions/store");
let sessionArchiveRuntimePromise: Promise<
  typeof import("../../gateway/session-archive.runtime.js")
> | null = null;
let sessionWriteLockAcquirerForTests: typeof acquireSessionWriteLock | null = null;

const SESSION_STORE_BACKFILL_DELAY_MS = 15_000;

type SessionStoreBackfillQueue = {
  timer: NodeJS.Timeout | null;
  flushing: boolean;
  entries: Map<string, SessionEntry>;
};

const SESSION_STORE_BACKFILL_QUEUES = new Map<string, SessionStoreBackfillQueue>();
const HOT_STORE_BOOTSTRAP_PROMISES = new Map<string, Promise<void>>();

function loadSessionArchiveRuntime() {
  sessionArchiveRuntimePromise ??= import("../../gateway/session-archive.runtime.js");
  return sessionArchiveRuntimePromise;
}

function removeThreadFromDeliveryContext(context?: DeliveryContext): DeliveryContext | undefined {
  if (!context || context.threadId == null) {
    return context;
  }
  const next: DeliveryContext = { ...context };
  delete next.threadId;
  return next;
}

function areProjectedHotEntriesEqual(
  left: SessionEntry | undefined,
  right: SessionEntry | undefined,
): boolean {
  return isDeepStrictEqual(
    left ? projectSessionEntryToHot(left) : undefined,
    right ? projectSessionEntryToHot(right) : undefined,
  );
}

export function normalizeStoreSessionKey(sessionKey: string): string {
  return normalizeLowercaseStringOrEmpty(sessionKey);
}

export function resolveSessionStoreEntry(params: {
  store: Record<string, SessionEntry>;
  sessionKey: string;
}): {
  normalizedKey: string;
  existing: SessionEntry | undefined;
  legacyKeys: string[];
} {
  const trimmedKey = params.sessionKey.trim();
  const normalizedKey = normalizeStoreSessionKey(trimmedKey);
  const legacyKeySet = new Set<string>();
  if (
    trimmedKey !== normalizedKey &&
    Object.prototype.hasOwnProperty.call(params.store, trimmedKey)
  ) {
    legacyKeySet.add(trimmedKey);
  }
  let existing =
    params.store[normalizedKey] ?? (legacyKeySet.size > 0 ? params.store[trimmedKey] : undefined);
  let existingUpdatedAt = existing?.updatedAt ?? 0;
  for (const [candidateKey, candidateEntry] of Object.entries(params.store)) {
    if (candidateKey === normalizedKey) {
      continue;
    }
    if (normalizeStoreSessionKey(candidateKey) !== normalizedKey) {
      continue;
    }
    legacyKeySet.add(candidateKey);
    const candidateUpdatedAt = candidateEntry?.updatedAt ?? 0;
    if (!existing || candidateUpdatedAt > existingUpdatedAt) {
      existing = candidateEntry;
      existingUpdatedAt = candidateUpdatedAt;
    }
  }
  return {
    normalizedKey,
    existing,
    legacyKeys: [...legacyKeySet],
  };
}

export function setSessionWriteLockAcquirerForTests(
  acquirer: typeof acquireSessionWriteLock | null,
): void {
  sessionWriteLockAcquirerForTests = acquirer;
}

export function resetSessionStoreLockRuntimeForTests(): void {
  sessionWriteLockAcquirerForTests = null;
}

export async function withSessionStoreLockForTest<T>(
  storePath: string,
  fn: () => Promise<T>,
  opts: SessionStoreLockOptions = {},
): Promise<T> {
  return await withSessionStoreLock(storePath, fn, opts);
}

function resolveSessionStoreTraceCaller(): string {
  const stack = new Error().stack ?? "";
  for (const line of stack.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("at ")) {
      continue;
    }
    if (trimmed.includes("resolveSessionStoreTraceCaller")) {
      continue;
    }
    if (trimmed.includes("src/config/sessions/store.ts")) {
      continue;
    }
    if (trimmed.includes("/dist/config/sessions/store-")) {
      continue;
    }
    if (trimmed.includes("/dist/config/sessions/store.js")) {
      continue;
    }
    if (trimmed.includes("/dist/store-")) {
      continue;
    }
    if (trimmed.includes("/dist/store.js")) {
      continue;
    }
    const match = trimmed.match(/(?:\(|\s)(src\/[^():]+:\d+:\d+)\)?$/);
    if (match?.[1]) {
      return match[1];
    }
    const distMatch = trimmed.match(/(?:\(|\s)(dist\/[^():]+(?:-[^():/]+)?\.js:\d+:\d+)\)?$/);
    if (distMatch?.[1]) {
      return distMatch[1];
    }
    return trimmed.replace(/^at\s+/, "");
  }
  return "unknown";
}

export function readSessionUpdatedAt(params: {
  storePath: string;
  sessionKey: string;
}): number | undefined {
  try {
    const store = loadSessionStore(params.storePath);
    const resolved = resolveSessionStoreEntry({ store, sessionKey: params.sessionKey });
    return resolved.existing?.updatedAt;
  } catch {
    return undefined;
  }
}

// ============================================================================
// Session Store Pruning, Capping & File Rotation
// ============================================================================

export type SessionMaintenanceApplyReport = {
  mode: ResolvedSessionMaintenanceConfig["mode"];
  beforeCount: number;
  afterCount: number;
  pruned: number;
  capped: number;
  diskBudget: SessionDiskBudgetSweepResult | null;
};

export {
  capEntryCount,
  getActiveSessionMaintenanceWarning,
  pruneStaleEntries,
  resolveMaintenanceConfig,
  rotateSessionFile,
};
export type { ResolvedSessionMaintenanceConfig, SessionMaintenanceWarning };

type SaveSessionStoreOptions = {
  /** Skip pruning, capping, and rotation (e.g. during one-time migrations). */
  skipMaintenance?: boolean;
  /** Active session key for warn-only maintenance. */
  activeSessionKey?: string;
  /**
   * Session keys that are allowed to drop persisted ACP metadata during this update.
   * All other updates preserve existing `entry.acp` blocks when callers replace the
   * whole session entry without carrying ACP state forward.
   */
  allowDropAcpMetaSessionKeys?: string[];
  /** Optional callback for warn-only maintenance. */
  onWarn?: (warning: SessionMaintenanceWarning) => void | Promise<void>;
  /** Optional callback with maintenance stats after a save. */
  onMaintenanceApplied?: (report: SessionMaintenanceApplyReport) => void | Promise<void>;
  /** Optional overrides used by maintenance commands. */
  maintenanceOverride?: Partial<ResolvedSessionMaintenanceConfig>;
  /** Fully resolved maintenance settings when the caller already has config loaded. */
  maintenanceConfig?: ResolvedSessionMaintenanceConfig;
  /** Internal: hot store writes must not recursively rewrite their own projection. */
  skipHotProjectionSync?: boolean;
};

function compactSessionSkillSnapshotForPersistence(
  snapshot: SessionEntry["skillsSnapshot"],
): SessionEntry["skillsSnapshot"] {
  if (!snapshot) {
    return snapshot;
  }
  const compacted = { ...snapshot, prompt: "" };
  delete compacted.resolvedSkills;
  return compacted;
}

function compactSessionSystemPromptReportForPersistence(
  report: SessionEntry["systemPromptReport"],
): SessionEntry["systemPromptReport"] {
  if (!report) {
    return report;
  }
  return {
    ...report,
    injectedWorkspaceFiles: [],
    skills: {
      ...report.skills,
      entries: [],
    },
    tools: {
      ...report.tools,
      entries: [],
    },
  };
}

function compactSessionEntryForPersistence(entry: SessionEntry): SessionEntry {
  const skillsSnapshot = compactSessionSkillSnapshotForPersistence(entry.skillsSnapshot);
  const systemPromptReport = compactSessionSystemPromptReportForPersistence(
    entry.systemPromptReport,
  );
  if (skillsSnapshot === entry.skillsSnapshot && systemPromptReport === entry.systemPromptReport) {
    return entry;
  }
  return {
    ...entry,
    skillsSnapshot,
    systemPromptReport,
  };
}

function compactSessionStoreForPersistence(
  store: Record<string, SessionEntry>,
): Record<string, SessionEntry> {
  let compacted: Record<string, SessionEntry> | undefined;
  for (const [key, entry] of Object.entries(store)) {
    const nextEntry = compactSessionEntryForPersistence(entry);
    if (nextEntry === entry) {
      continue;
    }
    compacted ??= { ...store };
    compacted[key] = nextEntry;
  }
  return compacted ?? store;
}

function updateSessionStoreWriteCaches(params: {
  storePath: string;
  store: Record<string, SessionEntry>;
  serialized: string;
}): void {
  const fileStat = getFileStatSnapshot(params.storePath);
  setSerializedSessionStore(params.storePath, params.serialized);
  if (!isSessionStoreCacheEnabled()) {
    dropSessionStoreObjectCache(params.storePath);
    return;
  }
  writeSessionStoreCache({
    storePath: params.storePath,
    store: params.store,
    mtimeMs: fileStat?.mtimeMs,
    sizeBytes: fileStat?.sizeBytes,
    serialized: params.serialized,
  });
}

async function syncHotSessionStoreProjection(params: {
  storePath: string;
  store: Record<string, SessionEntry>;
}): Promise<void> {
  if (isHotSessionStorePath(params.storePath)) {
    return;
  }
  const hotStorePath = resolveHotSessionStorePath(params.storePath);
  const hotStore = projectSessionStoreToHot(params.store);
  await fs.promises.mkdir(path.dirname(hotStorePath), { recursive: true });
  const serialized = JSON.stringify(hotStore, null, 2);
  if (getSerializedSessionStore(hotStorePath) === serialized) {
    updateSessionStoreWriteCaches({ storePath: hotStorePath, store: hotStore, serialized });
    return;
  }
  await writeTextAtomic(hotStorePath, serialized, { mode: 0o600 });
  updateSessionStoreWriteCaches({ storePath: hotStorePath, store: hotStore, serialized });
}

export async function ensureHotSessionStoreHydrated(storePath: string): Promise<void> {
  if (isHotSessionStorePath(storePath)) {
    return;
  }
  const hotStorePath = resolveHotSessionStorePath(storePath);
  if (fs.existsSync(hotStorePath)) {
    return;
  }
  const existing = HOT_STORE_BOOTSTRAP_PROMISES.get(storePath);
  if (existing) {
    await existing;
    return;
  }
  const bootstrapPromise = (async () => {
    const coldStore = loadSessionStore(storePath, { skipCache: true });
    await syncHotSessionStoreProjection({ storePath, store: coldStore });
  })().finally(() => {
    HOT_STORE_BOOTSTRAP_PROMISES.delete(storePath);
  });
  HOT_STORE_BOOTSTRAP_PROMISES.set(storePath, bootstrapPromise);
  await bootstrapPromise;
}

function rememberBackfillEntry(params: {
  storePath: string;
  sessionKey: string;
  entry: SessionEntry;
}): void {
  const queue = getOrCreateSessionStoreBackfillQueue(params.storePath);
  const existing = queue.entries.get(params.sessionKey);
  queue.entries.set(params.sessionKey, existing ? { ...existing, ...params.entry } : params.entry);
}

async function flushSessionStoreBackfillQueue(storePath: string): Promise<void> {
  const queue = SESSION_STORE_BACKFILL_QUEUES.get(storePath);
  if (!queue || queue.flushing || queue.entries.size === 0) {
    if (queue && !queue.flushing && queue.entries.size === 0 && !queue.timer) {
      SESSION_STORE_BACKFILL_QUEUES.delete(storePath);
    }
    return;
  }
  if (queue.timer) {
    clearTimeout(queue.timer);
    queue.timer = null;
  }
  const entries = [...queue.entries.entries()];
  queue.entries.clear();
  queue.flushing = true;
  try {
    await updateSessionStore(
      storePath,
      (store) => {
        for (const [sessionKey, entry] of entries) {
          const resolved = resolveSessionStoreEntry({ store, sessionKey });
          store[resolved.normalizedKey] = {
            ...store[resolved.normalizedKey],
            ...entry,
          };
          for (const legacyKey of resolved.legacyKeys) {
            delete store[legacyKey];
          }
        }
      },
      { activeSessionKey: entries[0]?.[0] },
    );
  } catch (error) {
    logVerbose(`session store cold backfill failed: ${String(error)}`);
    for (const [sessionKey, entry] of entries) {
      rememberBackfillEntry({ storePath, sessionKey, entry });
    }
  } finally {
    queue.flushing = false;
    if (queue.entries.size === 0) {
      if (!queue.timer) {
        SESSION_STORE_BACKFILL_QUEUES.delete(storePath);
      }
    } else {
      queue.timer = setTimeout(() => {
        void flushSessionStoreBackfillQueue(storePath);
      }, SESSION_STORE_BACKFILL_DELAY_MS);
      queue.timer.unref?.();
    }
  }
}

function scheduleSessionStoreBackfillFlush(storePath: string): void {
  const queue = getOrCreateSessionStoreBackfillQueue(storePath);
  if (queue.timer) {
    clearTimeout(queue.timer);
  }
  queue.timer = setTimeout(() => {
    void flushSessionStoreBackfillQueue(storePath);
  }, SESSION_STORE_BACKFILL_DELAY_MS);
  queue.timer.unref?.();
}

export async function writeHotSessionEntry(params: {
  storePath: string;
  sessionKey: string;
  createIfMissing?: boolean;
  mutator: (
    existing: SessionEntry | undefined,
    resolved: ReturnType<typeof resolveSessionStoreEntry>,
  ) => Promise<SessionEntry | null> | SessionEntry | null;
}): Promise<SessionEntry | null> {
  const traceCaller = resolveSessionStoreTraceCaller();
  const trace = createTimingTrace({
    channel: "session-store-trace",
    label: params.sessionKey,
    sink: "stderr",
    scope: "writeHotSessionEntry",
  });
  trace(
    "start",
    `caller=${traceCaller} createIfMissing=${params.createIfMissing === false ? "no" : "yes"}`,
  );
  trace("hydrate-start");
  await ensureHotSessionStoreHydrated(params.storePath);
  trace("hydrate-done");
  const hotStorePath = resolveHotSessionStorePath(params.storePath);
  trace("lock-wait-start");
  return await withSessionStoreLock(hotStorePath, async () => {
    trace("lock-acquired");
    const store = loadSessionStore(hotStorePath, { skipCache: true });
    trace("store-loaded", `entries=${Object.keys(store).length}`);
    const resolved = resolveSessionStoreEntry({ store, sessionKey: params.sessionKey });
    const existing = resolved.existing;
    trace(
      "entry-resolved",
      `hasExisting=${existing ? "yes" : "no"} legacyKeys=${resolved.legacyKeys.length}`,
    );
    if (!existing && params.createIfMissing === false) {
      trace("missing-entry");
      return null;
    }
    trace("mutator-start");
    const next = await params.mutator(existing, resolved);
    trace("mutator-done", `hasNext=${next ? "yes" : "no"}`);
    if (!next) {
      trace("no-next");
      return existing ?? null;
    }
    const nextHot = projectSessionEntryToHot(next);
    trace("project-hot-done");
    const canSkipPersist =
      resolved.legacyKeys.length === 0 &&
      Object.prototype.hasOwnProperty.call(store, resolved.normalizedKey) &&
      areProjectedHotEntriesEqual(existing, next);
    if (canSkipPersist) {
      trace("persist-skipped");
      return existing ?? next;
    }
    store[resolved.normalizedKey] = nextHot;
    for (const legacyKey of resolved.legacyKeys) {
      delete store[legacyKey];
    }
    trace("persist-start");
    await saveSessionStoreUnlocked(hotStorePath, store, {
      activeSessionKey: normalizeStoreSessionKey(params.sessionKey),
      skipMaintenance: true,
      skipHotProjectionSync: true,
    });
    trace("persist-done");
    return next;
  });
}

export function queueSessionStoreColdBackfill(params: {
  storePath: string;
  sessionKey: string;
  entry: SessionEntry;
}): void {
  rememberBackfillEntry(params);
  scheduleSessionStoreBackfillFlush(params.storePath);
}

export async function flushSessionStoreBackfillForTest(storePath: string): Promise<void> {
  await flushSessionStoreBackfillQueue(storePath);
}

export function resetSessionStoreBackfillRuntimeForTest(): void {
  for (const queue of SESSION_STORE_BACKFILL_QUEUES.values()) {
    if (queue.timer) {
      clearTimeout(queue.timer);
    }
  }
  SESSION_STORE_BACKFILL_QUEUES.clear();
  HOT_STORE_BOOTSTRAP_PROMISES.clear();
}

function resolveMutableSessionStoreKey(
  store: Record<string, SessionEntry>,
  sessionKey: string,
): string | undefined {
  const trimmed = sessionKey.trim();
  if (!trimmed) {
    return undefined;
  }
  if (Object.prototype.hasOwnProperty.call(store, trimmed)) {
    return trimmed;
  }
  const normalized = normalizeStoreSessionKey(trimmed);
  if (Object.prototype.hasOwnProperty.call(store, normalized)) {
    return normalized;
  }
  return Object.keys(store).find((key) => normalizeStoreSessionKey(key) === normalized);
}

function collectAcpMetadataSnapshot(
  store: Record<string, SessionEntry>,
): Map<string, NonNullable<SessionEntry["acp"]>> {
  const snapshot = new Map<string, NonNullable<SessionEntry["acp"]>>();
  for (const [sessionKey, entry] of Object.entries(store)) {
    if (entry?.acp) {
      snapshot.set(sessionKey, entry.acp);
    }
  }
  return snapshot;
}

function preserveExistingAcpMetadata(params: {
  previousAcpByKey: Map<string, NonNullable<SessionEntry["acp"]>>;
  nextStore: Record<string, SessionEntry>;
  allowDropSessionKeys?: string[];
}): void {
  const allowDrop = new Set(
    (params.allowDropSessionKeys ?? []).map((key) => normalizeStoreSessionKey(key)),
  );
  for (const [previousKey, previousAcp] of params.previousAcpByKey.entries()) {
    const normalizedKey = normalizeStoreSessionKey(previousKey);
    if (allowDrop.has(normalizedKey)) {
      continue;
    }
    const nextKey = resolveMutableSessionStoreKey(params.nextStore, previousKey);
    if (!nextKey) {
      continue;
    }
    const nextEntry = params.nextStore[nextKey];
    if (!nextEntry || nextEntry.acp) {
      continue;
    }
    params.nextStore[nextKey] = {
      ...nextEntry,
      acp: previousAcp,
    };
  }
}

async function saveSessionStoreUnlocked(
  storePath: string,
  store: Record<string, SessionEntry>,
  opts?: SaveSessionStoreOptions,
): Promise<void> {
  const trace = createTimingTrace({
    channel: "session-store-trace",
    label: opts?.activeSessionKey ?? "store",
    sink: "stderr",
    scope: "saveSessionStoreUnlocked",
  });
  trace(
    "start",
    `hot=${isHotSessionStorePath(storePath) ? "yes" : "no"} skipMaintenance=${opts?.skipMaintenance ? "yes" : "no"}`,
  );
  normalizeSessionStore(store);
  trace("normalize-done", `entries=${Object.keys(store).length}`);

  if (!opts?.skipMaintenance && !isHotSessionStorePath(storePath)) {
    // Resolve maintenance config once (avoids repeated loadConfig() calls).
    const maintenance = opts?.maintenanceConfig
      ? { ...opts.maintenanceConfig, ...opts?.maintenanceOverride }
      : { ...resolveMaintenanceConfig(), ...opts?.maintenanceOverride };
    trace("maintenance-resolved", `mode=${maintenance.mode}`);
    const shouldWarnOnly = maintenance.mode === "warn";
    const beforeCount = Object.keys(store).length;

    if (shouldWarnOnly) {
      const activeSessionKey = opts?.activeSessionKey?.trim();
      if (activeSessionKey) {
        const warning = getActiveSessionMaintenanceWarning({
          store,
          activeSessionKey,
          pruneAfterMs: maintenance.pruneAfterMs,
          maxEntries: maintenance.maxEntries,
        });
        if (warning) {
          log.warn("session maintenance would evict active session; skipping enforcement", {
            activeSessionKey: warning.activeSessionKey,
            wouldPrune: warning.wouldPrune,
            wouldCap: warning.wouldCap,
            pruneAfterMs: warning.pruneAfterMs,
            maxEntries: warning.maxEntries,
          });
          await opts?.onWarn?.(warning);
        }
      }
      const diskBudget = await enforceSessionDiskBudget({
        store,
        storePath,
        activeSessionKey: opts?.activeSessionKey,
        maintenance,
        warnOnly: true,
        log,
      });
      await opts?.onMaintenanceApplied?.({
        mode: maintenance.mode,
        beforeCount,
        afterCount: Object.keys(store).length,
        pruned: 0,
        capped: 0,
        diskBudget,
      });
      trace("maintenance-warn-done", `entries=${Object.keys(store).length}`);
    } else {
      // Prune stale entries and cap total count before serializing.
      const removedSessionFiles = new Map<string, string | undefined>();
      const pruned = pruneStaleEntries(store, maintenance.pruneAfterMs, {
        onPruned: ({ entry }) => {
          rememberRemovedSessionFile(removedSessionFiles, entry);
        },
      });
      const capped = capEntryCount(store, maintenance.maxEntries, {
        onCapped: ({ entry }) => {
          rememberRemovedSessionFile(removedSessionFiles, entry);
        },
      });
      const archivedDirs = new Set<string>();
      const referencedSessionIds = new Set(
        Object.values(store)
          .map((entry) => entry?.sessionId)
          .filter((id): id is string => Boolean(id)),
      );
      const archivedForDeletedSessions = await archiveRemovedSessionTranscripts({
        removedSessionFiles,
        referencedSessionIds,
        storePath,
        reason: "deleted",
        restrictToStoreDir: true,
      });
      for (const archivedDir of archivedForDeletedSessions) {
        archivedDirs.add(archivedDir);
      }
      if (archivedDirs.size > 0 || maintenance.resetArchiveRetentionMs != null) {
        const { cleanupArchivedSessionTranscripts } = await loadSessionArchiveRuntime();
        const targetDirs =
          archivedDirs.size > 0 ? [...archivedDirs] : [path.dirname(path.resolve(storePath))];
        await cleanupArchivedSessionTranscripts({
          directories: targetDirs,
          olderThanMs: maintenance.pruneAfterMs,
          reason: "deleted",
        });
        if (maintenance.resetArchiveRetentionMs != null) {
          await cleanupArchivedSessionTranscripts({
            directories: targetDirs,
            olderThanMs: maintenance.resetArchiveRetentionMs,
            reason: "reset",
          });
        }
      }

      // Rotate the on-disk file if it exceeds the size threshold.
      await rotateSessionFile(storePath, maintenance.rotateBytes);
      trace(
        "maintenance-prune-done",
        `entries=${Object.keys(store).length} archivedDirs=${archivedDirs.size}`,
      );

      const diskBudget = await enforceSessionDiskBudget({
        store,
        storePath,
        activeSessionKey: opts?.activeSessionKey,
        maintenance,
        warnOnly: false,
        log,
      });
      await opts?.onMaintenanceApplied?.({
        mode: maintenance.mode,
        beforeCount,
        afterCount: Object.keys(store).length,
        pruned,
        capped,
        diskBudget,
      });
      trace(
        "maintenance-disk-budget-done",
        `entries=${Object.keys(store).length} pruned=${pruned} capped=${capped}`,
      );
    }
  }

  await fs.promises.mkdir(path.dirname(storePath), { recursive: true });
  trace("mkdir-done");
  const persistedStore = compactSessionStoreForPersistence(store);
  const json = JSON.stringify(persistedStore, null, 2);
  trace("json-serialized", `bytes=${Buffer.byteLength(json)}`);
  if (getSerializedSessionStore(storePath) === json) {
    updateSessionStoreWriteCaches({ storePath, store, serialized: json });
    if (!opts?.skipHotProjectionSync) {
      await syncHotSessionStoreProjection({ storePath, store });
    }
    trace("write-skipped-cache-hit");
    return;
  }

  // Windows: keep retry semantics because rename can fail while readers hold locks.
  if (process.platform === "win32") {
    for (let i = 0; i < 5; i++) {
      try {
        await writeSessionStoreAtomic({ storePath, store, serialized: json });
        if (!opts?.skipHotProjectionSync) {
          await syncHotSessionStoreProjection({ storePath, store });
        }
        trace("write-atomic-done", "platform=win32");
        return;
      } catch (err) {
        const code = getErrorCode(err);
        if (code === "ENOENT") {
          return;
        }
        if (i < 4) {
          await new Promise((r) => setTimeout(r, 50 * (i + 1)));
          continue;
        }
        // Final attempt failed — skip this save. The write lock ensures
        // the next save will retry with fresh data. Log for diagnostics.
        log.warn(`atomic write failed after 5 attempts: ${storePath}`);
      }
    }
    return;
  }

  try {
    await writeSessionStoreAtomic({ storePath, store, serialized: json });
    if (!opts?.skipHotProjectionSync) {
      await syncHotSessionStoreProjection({ storePath, store });
    }
    trace("write-atomic-done");
  } catch (err) {
    const code = getErrorCode(err);

    if (code === "ENOENT") {
      // In tests the temp session-store directory may be deleted while writes are in-flight.
      // Best-effort: try a direct write (recreating the parent dir), otherwise ignore.
      try {
        await writeSessionStoreAtomic({ storePath, store, serialized: json });
        if (!opts?.skipHotProjectionSync) {
          await syncHotSessionStoreProjection({ storePath, store });
        }
      } catch (err2) {
        const code2 = getErrorCode(err2);
        if (code2 === "ENOENT") {
          return;
        }
        throw err2;
      }
      return;
    }

    throw err;
  }
}

export async function saveSessionStore(
  storePath: string,
  store: Record<string, SessionEntry>,
  opts?: SaveSessionStoreOptions,
): Promise<void> {
  await withSessionStoreLock(storePath, async () => {
    await saveSessionStoreUnlocked(storePath, store, opts);
  });
}

export async function updateSessionStore<T>(
  storePath: string,
  mutator: (store: Record<string, SessionEntry>) => Promise<T> | T,
  opts?: SaveSessionStoreOptions,
): Promise<T> {
  const traceCaller = resolveSessionStoreTraceCaller();
  const trace = createTimingTrace({
    channel: "session-store-trace",
    label: "store",
    sink: "stderr",
    scope: "updateSessionStore",
  });
  trace("start", `caller=${traceCaller}`);
  trace("lock-wait-start", `caller=${traceCaller}`);
  return await withSessionStoreLock(storePath, async () => {
    trace("lock-acquired", `caller=${traceCaller}`);
    // Always re-read inside the lock to avoid clobbering concurrent writers.
    const store = loadSessionStore(storePath, { skipCache: true });
    trace("store-loaded", `caller=${traceCaller} entries=${Object.keys(store).length}`);
    const previousAcpByKey = collectAcpMetadataSnapshot(store);
    const result = await mutator(store);
    trace("mutator-done", `caller=${traceCaller}`);
    preserveExistingAcpMetadata({
      previousAcpByKey,
      nextStore: store,
      allowDropSessionKeys: opts?.allowDropAcpMetaSessionKeys,
    });
    trace("preserve-acp-done", `caller=${traceCaller}`);
    const persistStartedAt = Date.now();
    await saveSessionStoreUnlocked(storePath, store, opts);
    trace("persisted", `caller=${traceCaller} persistMs=${Date.now() - persistStartedAt}`);
    return result;
  });
}

type SessionStoreLockOptions = {
  timeoutMs?: number;
  pollIntervalMs?: number;
  staleMs?: number;
};

const SESSION_STORE_LOCK_MIN_HOLD_MS = 5_000;
const SESSION_STORE_LOCK_TIMEOUT_GRACE_MS = 5_000;

function getErrorCode(error: unknown): string | null {
  if (!error || typeof error !== "object" || !("code" in error)) {
    return null;
  }
  return String((error as { code?: unknown }).code);
}

function rememberRemovedSessionFile(
  removedSessionFiles: Map<string, string | undefined>,
  entry: SessionEntry,
): void {
  if (!removedSessionFiles.has(entry.sessionId) || entry.sessionFile) {
    removedSessionFiles.set(entry.sessionId, entry.sessionFile);
  }
}

export async function archiveRemovedSessionTranscripts(params: {
  removedSessionFiles: Iterable<[string, string | undefined]>;
  referencedSessionIds: ReadonlySet<string>;
  storePath: string;
  reason: "deleted" | "reset";
  restrictToStoreDir?: boolean;
}): Promise<Set<string>> {
  const { archiveSessionTranscripts } = await loadSessionArchiveRuntime();
  const archivedDirs = new Set<string>();
  for (const [sessionId, sessionFile] of params.removedSessionFiles) {
    if (params.referencedSessionIds.has(sessionId)) {
      continue;
    }
    const archived = archiveSessionTranscripts({
      sessionId,
      storePath: params.storePath,
      sessionFile,
      reason: params.reason,
      restrictToStoreDir: params.restrictToStoreDir,
    });
    for (const archivedPath of archived) {
      archivedDirs.add(path.dirname(archivedPath));
    }
  }
  return archivedDirs;
}

async function writeSessionStoreAtomic(params: {
  storePath: string;
  store: Record<string, SessionEntry>;
  serialized: string;
}): Promise<void> {
  await writeTextAtomic(params.storePath, params.serialized, { mode: 0o600 });
  updateSessionStoreWriteCaches({
    storePath: params.storePath,
    store: params.store,
    serialized: params.serialized,
  });
}

async function persistResolvedSessionEntry(params: {
  storePath: string;
  store: Record<string, SessionEntry>;
  resolved: ReturnType<typeof resolveSessionStoreEntry>;
  next: SessionEntry;
}): Promise<SessionEntry> {
  params.store[params.resolved.normalizedKey] = params.next;
  for (const legacyKey of params.resolved.legacyKeys) {
    delete params.store[legacyKey];
  }
  await saveSessionStoreUnlocked(params.storePath, params.store, {
    activeSessionKey: params.resolved.normalizedKey,
  });
  return params.next;
}

function lockTimeoutError(storePath: string): Error {
  return new Error(`timeout waiting for session store lock: ${storePath}`);
}

function resolveSessionStoreLockMaxHoldMs(timeoutMs: number | undefined): number | undefined {
  if (timeoutMs == null || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return undefined;
  }
  return resolveSessionLockMaxHoldFromTimeout({
    timeoutMs,
    graceMs: SESSION_STORE_LOCK_TIMEOUT_GRACE_MS,
    minMs: SESSION_STORE_LOCK_MIN_HOLD_MS,
  });
}

function getOrCreateLockQueue(storePath: string): SessionStoreLockQueue {
  const existing = LOCK_QUEUES.get(storePath);
  if (existing) {
    return existing;
  }
  const created: SessionStoreLockQueue = { running: false, pending: [], drainPromise: null };
  LOCK_QUEUES.set(storePath, created);
  return created;
}

async function drainSessionStoreLockQueue(storePath: string): Promise<void> {
  const queue = LOCK_QUEUES.get(storePath);
  if (!queue) {
    return;
  }
  if (queue.drainPromise) {
    await queue.drainPromise;
    return;
  }
  queue.running = true;
  queue.drainPromise = (async () => {
    try {
      while (queue.pending.length > 0) {
        const task = queue.pending.shift();
        if (!task) {
          continue;
        }

        const remainingTimeoutMs = task.timeoutMs ?? Number.POSITIVE_INFINITY;
        if (task.timeoutMs != null && remainingTimeoutMs <= 0) {
          task.reject(lockTimeoutError(storePath));
          continue;
        }

        let lock: { release: () => Promise<void> } | undefined;
        let result: unknown;
        let failed: unknown;
        let hasFailure = false;
        try {
          task.onAcquireStart?.();
          lock = await (sessionWriteLockAcquirerForTests ?? acquireSessionWriteLock)({
            sessionFile: storePath,
            timeoutMs: remainingTimeoutMs,
            staleMs: task.staleMs,
            maxHoldMs: resolveSessionStoreLockMaxHoldMs(task.timeoutMs),
          });
          task.onAcquireDone?.();
          result = await task.fn();
        } catch (err) {
          hasFailure = true;
          failed = err;
        } finally {
          await lock?.release().catch(() => undefined);
          task.onReleaseDone?.();
        }
        if (hasFailure) {
          task.reject(failed);
          continue;
        }
        task.resolve(result);
      }
    } finally {
      queue.running = false;
      queue.drainPromise = null;
      if (queue.pending.length === 0) {
        LOCK_QUEUES.delete(storePath);
      } else {
        queueMicrotask(() => {
          void drainSessionStoreLockQueue(storePath);
        });
      }
    }
  })();
  await queue.drainPromise;
}

async function withSessionStoreLock<T>(
  storePath: string,
  fn: () => Promise<T>,
  opts: SessionStoreLockOptions = {},
): Promise<T> {
  if (!storePath || typeof storePath !== "string") {
    throw new Error(
      `withSessionStoreLock: storePath must be a non-empty string, got ${JSON.stringify(storePath)}`,
    );
  }
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const staleMs = opts.staleMs ?? 30_000;
  // `pollIntervalMs` is retained for API compatibility with older lock options.
  void opts.pollIntervalMs;

  const hasTimeout = timeoutMs > 0 && Number.isFinite(timeoutMs);
  const queue = getOrCreateLockQueue(storePath);
  const trace = createTimingTrace({
    channel: "session-store-trace",
    label: path.basename(storePath) || "store",
    sink: "stderr",
    scope: "withSessionStoreLock",
  });
  trace(
    "enqueue",
    `running=${queue.running ? "yes" : "no"} pending=${queue.pending.length} timeoutMs=${hasTimeout ? timeoutMs : "none"} staleMs=${staleMs}`,
  );

  const promise = new Promise<T>((resolve, reject) => {
    const task: SessionStoreLockTask = {
      fn: async () => {
        trace("fn-start");
        const result = await fn();
        trace("fn-done");
        return result;
      },
      onAcquireStart: () => trace("file-lock-start"),
      onAcquireDone: () => trace("file-lock-done"),
      onReleaseDone: () => trace("file-lock-release-done"),
      resolve: (value) => resolve(value as T),
      reject,
      timeoutMs: hasTimeout ? timeoutMs : undefined,
      staleMs,
    };

    queue.pending.push(task);
    trace("queued", `pending=${queue.pending.length}`);
    void drainSessionStoreLockQueue(storePath);
  });

  const result = await promise;
  trace("done");
  return result;
}

export async function updateSessionStoreEntry(params: {
  storePath: string;
  sessionKey: string;
  update: (entry: SessionEntry) => Promise<Partial<SessionEntry> | null>;
}): Promise<SessionEntry | null> {
  const { storePath, sessionKey, update } = params;
  const traceCaller = resolveSessionStoreTraceCaller();
  const trace = createTimingTrace({
    channel: "session-store-trace",
    label: sessionKey,
    sink: "stderr",
    scope: "updateSessionStoreEntry",
  });
  trace("start", `caller=${traceCaller}`);
  trace("lock-wait-start", `caller=${traceCaller}`);
  return await withSessionStoreLock(storePath, async () => {
    trace("lock-acquired", `caller=${traceCaller}`);
    const store = loadSessionStore(storePath, { skipCache: true });
    trace("store-loaded", `caller=${traceCaller} entries=${Object.keys(store).length}`);
    const resolved = resolveSessionStoreEntry({ store, sessionKey });
    const existing = resolved.existing;
    if (!existing) {
      trace("missing-entry", `caller=${traceCaller}`);
      return null;
    }
    const patch = await update(existing);
    trace("patch-computed", `caller=${traceCaller} hasPatch=${patch ? "yes" : "no"}`);
    if (!patch) {
      return existing;
    }
    const next = mergeSessionEntry(existing, patch);
    trace("entry-merged", `caller=${traceCaller}`);
    const persistStartedAt = Date.now();
    return await persistResolvedSessionEntry({
      storePath,
      store,
      resolved,
      next,
    }).then((result) => {
      trace("persisted", `caller=${traceCaller} persistMs=${Date.now() - persistStartedAt}`);
      return result;
    });
  });
}

export async function recordSessionMetaFromInbound(params: {
  storePath: string;
  sessionKey: string;
  ctx: MsgContext;
  groupResolution?: import("./types.js").GroupKeyResolution | null;
  createIfMissing?: boolean;
}): Promise<SessionEntry | null> {
  const { storePath, sessionKey, ctx } = params;
  const createIfMissing = params.createIfMissing ?? true;
  const next = await writeHotSessionEntry({
    storePath,
    sessionKey,
    createIfMissing,
    mutator: async (existing, resolved) => {
      const patch = deriveSessionMetaPatch({
        ctx,
        sessionKey: resolved.normalizedKey,
        existing,
        groupResolution: params.groupResolution,
      });
      if (!patch) {
        return existing ?? null;
      }
      return existing
        ? // Inbound metadata updates must not refresh activity timestamps;
          // idle reset evaluation relies on updatedAt from actual session turns.
          mergeSessionEntryPreserveActivity(existing, patch)
        : mergeSessionEntry(existing, patch);
    },
  });
  if (next) {
    queueSessionStoreColdBackfill({
      storePath,
      sessionKey: normalizeStoreSessionKey(sessionKey),
      entry: next,
    });
  }
  return next;
}

export async function updateLastRoute(params: {
  storePath: string;
  sessionKey: string;
  channel?: SessionEntry["lastChannel"];
  to?: string;
  accountId?: string;
  threadId?: string | number;
  deliveryContext?: DeliveryContext;
  ctx?: MsgContext;
  groupResolution?: import("./types.js").GroupKeyResolution | null;
}): Promise<SessionEntry> {
  const { storePath, sessionKey, channel, to, accountId, threadId, ctx } = params;
  const trace = createTimingTrace({
    channel: "session-store-trace",
    label: sessionKey,
    sink: "stderr",
    scope: "updateLastRoute",
  });
  let shouldQueueColdBackfill = false;
  const next = await writeHotSessionEntry({
    storePath,
    sessionKey,
    mutator: async (existing) => {
      const explicitContext = normalizeDeliveryContext(params.deliveryContext);
      const inlineContext = normalizeDeliveryContext({
        channel,
        to,
        accountId,
        threadId,
      });
      const mergedInput = mergeDeliveryContext(explicitContext, inlineContext);
      const explicitDeliveryContext = params.deliveryContext;
      const explicitThreadFromDeliveryContext =
        explicitDeliveryContext != null &&
        Object.prototype.hasOwnProperty.call(explicitDeliveryContext, "threadId")
          ? explicitDeliveryContext.threadId
          : undefined;
      const explicitThreadValue =
        explicitThreadFromDeliveryContext ??
        (threadId != null && threadId !== "" ? threadId : undefined);
      const explicitRouteProvided = Boolean(
        explicitContext?.channel ||
        explicitContext?.to ||
        inlineContext?.channel ||
        inlineContext?.to,
      );
      const clearThreadFromFallback = explicitRouteProvided && explicitThreadValue == null;
      const fallbackContext = clearThreadFromFallback
        ? removeThreadFromDeliveryContext(deliveryContextFromSession(existing))
        : deliveryContextFromSession(existing);
      const merged = mergeDeliveryContext(mergedInput, fallbackContext);
      const normalized = normalizeSessionDeliveryFields({
        deliveryContext: {
          channel: merged?.channel,
          to: merged?.to,
          accountId: merged?.accountId,
          threadId: merged?.threadId,
        },
      });
      const metaPatch = ctx
        ? deriveSessionMetaPatch({
            ctx,
            sessionKey: normalizeStoreSessionKey(sessionKey),
            existing,
            groupResolution: params.groupResolution,
          })
        : null;
      const basePatch: Partial<SessionEntry> = {
        deliveryContext: normalized.deliveryContext,
        lastChannel: normalized.lastChannel,
        lastTo: normalized.lastTo,
        lastAccountId: normalized.lastAccountId,
        lastThreadId: normalized.lastThreadId,
      };
      const nextPatch = metaPatch ? { ...basePatch, ...metaPatch } : basePatch;
      const nextEntry = mergeSessionEntryPreserveActivity(existing, nextPatch);
      if (existing && areProjectedHotEntriesEqual(existing, nextEntry)) {
        return existing;
      }
      shouldQueueColdBackfill = true;
      return nextEntry;
    },
  });
  trace("hot-write-done");
  if (!next) {
    throw new Error(`updateLastRoute: failed to persist route for ${sessionKey}`);
  }
  if (shouldQueueColdBackfill) {
    queueSessionStoreColdBackfill({
      storePath,
      sessionKey: normalizeStoreSessionKey(sessionKey),
      entry: next,
    });
    trace("cold-backfill-queued");
  } else {
    trace("cold-backfill-skipped");
  }
  return next;
}
