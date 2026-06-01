import { chmodSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync, StatementSync } from "node:sqlite";
import { requireNodeSqlite } from "../../infra/node-sqlite.js";
import { normalizeLowercaseStringOrEmpty } from "../../shared/string-coerce.js";
import { normalizeSessionDeliveryFields } from "../../utils/delivery-context.shared.js";
import { applySessionStoreMigrations } from "./store-migrations.js";
import { normalizeSessionRuntimeModelFields, type SessionEntry } from "./types.js";

type SessionEntryRow = {
  session_key: string;
  normalized_key: string;
  session_id: string;
  updated_at: number | bigint;
  created_at: number | bigint | null;
  entry_json: string;
};

type SessionStoreSqliteStatements = {
  selectAll: StatementSync;
  selectByKey: StatementSync;
  selectUpdatedAtByKey: StatementSync;
  upsertEntry: StatementSync;
  deleteEntry: StatementSync;
  clearEntries: StatementSync;
};

type SessionStoreSqliteDatabase = {
  db: DatabaseSync;
  path: string;
  statements: SessionStoreSqliteStatements;
};

const SESSION_STORE_DB_CACHE = new Map<string, SessionStoreSqliteDatabase>();
const SESSION_STORE_DB_DIR_MODE = 0o700;
const SESSION_STORE_DB_FILE_MODE = 0o600;
const SESSION_STORE_SQLITE_SUFFIXES = ["", "-shm", "-wal"] as const;

function normalizeNumber(value: number | bigint | null | undefined): number | undefined {
  if (typeof value === "bigint") {
    return Number(value);
  }
  return typeof value === "number" ? value : undefined;
}

export function resolveSessionStoreSqlitePath(storePath: string): string {
  const resolved = path.resolve(storePath);
  if (resolved.endsWith(".sqlite") || resolved.endsWith(".db")) {
    return resolved;
  }
  if (resolved.endsWith(".hot.json")) {
    return resolved.slice(0, -".hot.json".length) + ".sqlite";
  }
  if (resolved.endsWith(".json")) {
    return resolved.slice(0, -".json".length) + ".sqlite";
  }
  return `${resolved}.sqlite`;
}

function hardenSessionStoreSqliteFiles(sqlitePath: string): void {
  for (const suffix of SESSION_STORE_SQLITE_SUFFIXES) {
    const candidate = `${sqlitePath}${suffix}`;
    if (existsSync(candidate)) {
      chmodSync(candidate, SESSION_STORE_DB_FILE_MODE);
    }
  }
}

function normalizeSessionEntryDelivery(entry: SessionEntry): SessionEntry {
  const normalized = normalizeSessionDeliveryFields({
    channel: entry.channel,
    lastChannel: entry.lastChannel,
    lastTo: entry.lastTo,
    lastAccountId: entry.lastAccountId,
    lastThreadId: entry.lastThreadId ?? entry.deliveryContext?.threadId ?? entry.origin?.threadId,
    deliveryContext: entry.deliveryContext,
  });
  const nextDelivery = normalized.deliveryContext;
  const sameDelivery =
    (entry.deliveryContext?.channel ?? undefined) === nextDelivery?.channel &&
    (entry.deliveryContext?.to ?? undefined) === nextDelivery?.to &&
    (entry.deliveryContext?.accountId ?? undefined) === nextDelivery?.accountId &&
    (entry.deliveryContext?.threadId ?? undefined) === nextDelivery?.threadId;
  const sameLast =
    entry.lastChannel === normalized.lastChannel &&
    entry.lastTo === normalized.lastTo &&
    entry.lastAccountId === normalized.lastAccountId &&
    entry.lastThreadId === normalized.lastThreadId;
  if (sameDelivery && sameLast) {
    return entry;
  }
  return {
    ...entry,
    deliveryContext: nextDelivery,
    lastChannel: normalized.lastChannel,
    lastTo: normalized.lastTo,
    lastAccountId: normalized.lastAccountId,
    lastThreadId: normalized.lastThreadId,
  };
}

export function normalizeSessionStoreForSqlite(store: Record<string, SessionEntry>): void {
  for (const [key, entry] of Object.entries(store)) {
    if (!entry) {
      continue;
    }
    const normalized = normalizeSessionEntryDelivery(normalizeSessionRuntimeModelFields(entry));
    if (normalized !== entry) {
      store[key] = normalized;
    }
  }
}

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

function normalizeStoreSessionKey(sessionKey: string): string {
  return normalizeLowercaseStringOrEmpty(sessionKey);
}

function parseSessionEntry(row: Pick<SessionEntryRow, "entry_json">): SessionEntry | undefined {
  try {
    const parsed = JSON.parse(row.entry_json) as SessionEntry;
    return normalizeSessionEntryDelivery(normalizeSessionRuntimeModelFields(parsed));
  } catch {
    return undefined;
  }
}

function rowToStoreEntry(row: SessionEntryRow): [string, SessionEntry] | undefined {
  const entry = parseSessionEntry(row);
  if (!entry) {
    return undefined;
  }
  return [row.session_key, entry];
}

function serializeSessionEntry(entry: SessionEntry): string {
  const compacted = compactSessionEntryForPersistence(
    normalizeSessionEntryDelivery(normalizeSessionRuntimeModelFields(entry)),
  );
  return JSON.stringify(compacted);
}

function bindSessionEntry(sessionKey: string, entry: SessionEntry) {
  const normalizedKey = normalizeStoreSessionKey(sessionKey);
  const persisted = compactSessionEntryForPersistence(
    normalizeSessionEntryDelivery(normalizeSessionRuntimeModelFields(entry)),
  );
  return {
    session_key: normalizedKey,
    normalized_key: normalizedKey,
    session_id: persisted.sessionId ?? normalizedKey,
    updated_at: persisted.updatedAt ?? Date.now(),
    created_at: persisted.createdAt ?? null,
    entry_json: JSON.stringify(persisted),
  };
}

function createStatements(db: DatabaseSync): SessionStoreSqliteStatements {
  return {
    selectAll: db.prepare(`
      SELECT
        session_key,
        normalized_key,
        session_id,
        updated_at,
        created_at,
        entry_json
      FROM session_entries
      ORDER BY updated_at DESC, session_key ASC
    `),
    selectByKey: db.prepare(`
      SELECT
        session_key,
        normalized_key,
        session_id,
        updated_at,
        created_at,
        entry_json
      FROM session_entries
      WHERE session_key = ? OR normalized_key = ?
      ORDER BY updated_at DESC
      LIMIT 1
    `),
    selectUpdatedAtByKey: db.prepare(`
      SELECT updated_at
      FROM session_entries
      WHERE session_key = ? OR normalized_key = ?
      ORDER BY updated_at DESC
      LIMIT 1
    `),
    upsertEntry: db.prepare(`
      INSERT INTO session_entries (
        session_key,
        normalized_key,
        session_id,
        updated_at,
        created_at,
        entry_json
      ) VALUES (
        :session_key,
        :normalized_key,
        :session_id,
        :updated_at,
        :created_at,
        :entry_json
      )
      ON CONFLICT(session_key) DO UPDATE SET
        normalized_key = excluded.normalized_key,
        session_id = excluded.session_id,
        updated_at = excluded.updated_at,
        created_at = excluded.created_at,
        entry_json = excluded.entry_json
    `),
    deleteEntry: db.prepare(`DELETE FROM session_entries WHERE session_key = ?`),
    clearEntries: db.prepare(`DELETE FROM session_entries`),
  };
}

function ensureSchema(db: DatabaseSync): void {
  db.exec(`
    PRAGMA busy_timeout = 5000;
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA temp_store = MEMORY;

    CREATE TABLE IF NOT EXISTS session_entries (
      session_key TEXT PRIMARY KEY,
      normalized_key TEXT NOT NULL UNIQUE,
      session_id TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      created_at INTEGER,
      entry_json TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_session_entries_session_id
      ON session_entries(session_id);
    CREATE INDEX IF NOT EXISTS idx_session_entries_updated_at
      ON session_entries(updated_at DESC);
  `);
}

function getSessionStoreDatabase(storePath: string): SessionStoreSqliteDatabase {
  const sqlitePath = resolveSessionStoreSqlitePath(storePath);
  const cached = SESSION_STORE_DB_CACHE.get(sqlitePath);
  if (cached) {
    return cached;
  }
  mkdirSync(path.dirname(sqlitePath), { recursive: true, mode: SESSION_STORE_DB_DIR_MODE });
  const { DatabaseSync } = requireNodeSqlite();
  const db = new DatabaseSync(sqlitePath);
  ensureSchema(db);
  hardenSessionStoreSqliteFiles(sqlitePath);
  const store = {
    db,
    path: sqlitePath,
    statements: createStatements(db),
  };
  SESSION_STORE_DB_CACHE.set(sqlitePath, store);
  return store;
}

function withImmediateTransaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

export function loadSessionStoreFromSqlite(storePath: string): Record<string, SessionEntry> {
  const { statements } = getSessionStoreDatabase(storePath);
  const rows = statements.selectAll.all() as SessionEntryRow[];
  const store: Record<string, SessionEntry> = {};
  for (const row of rows) {
    const entry = rowToStoreEntry(row);
    if (entry) {
      store[entry[0]] = entry[1];
    }
  }
  applySessionStoreMigrations(store);
  normalizeSessionStoreForSqlite(store);
  return structuredClone(store);
}

export function loadSessionEntryFromSqlite(
  storePath: string,
  sessionKey: string,
): SessionEntry | undefined {
  const normalizedKey = normalizeStoreSessionKey(sessionKey);
  const { statements } = getSessionStoreDatabase(storePath);
  const row = statements.selectByKey.get(normalizedKey, normalizedKey) as
    | SessionEntryRow
    | undefined;
  return row ? structuredClone(parseSessionEntry(row)) : undefined;
}

export function readSessionUpdatedAtFromSqlite(params: {
  storePath: string;
  sessionKey: string;
}): number | undefined {
  const normalizedKey = normalizeStoreSessionKey(params.sessionKey);
  const { statements } = getSessionStoreDatabase(params.storePath);
  const row = statements.selectUpdatedAtByKey.get(normalizedKey, normalizedKey) as
    | { updated_at: number | bigint | null }
    | undefined;
  return normalizeNumber(row?.updated_at);
}

export function upsertSessionEntryInSqlite(params: {
  storePath: string;
  sessionKey: string;
  entry: SessionEntry;
  skipIfUnchanged?: boolean;
}): SessionEntry {
  const normalizedKey = normalizeStoreSessionKey(params.sessionKey);
  const nextEntry = normalizeSessionEntryDelivery(normalizeSessionRuntimeModelFields(params.entry));
  const store = getSessionStoreDatabase(params.storePath);
  const nextSerialized = serializeSessionEntry(nextEntry);
  if (params.skipIfUnchanged) {
    const current = store.statements.selectByKey.get(normalizedKey, normalizedKey) as
      | SessionEntryRow
      | undefined;
    if (current?.entry_json === nextSerialized) {
      return structuredClone(nextEntry);
    }
  }
  store.statements.upsertEntry.run({
    ...bindSessionEntry(normalizedKey, nextEntry),
    entry_json: nextSerialized,
  });
  return structuredClone(nextEntry);
}

export function saveSessionStoreToSqlite(params: {
  storePath: string;
  store: Record<string, SessionEntry>;
  previousStore?: Record<string, SessionEntry>;
}): void {
  const database = getSessionStoreDatabase(params.storePath);
  const normalizedStore: Record<string, SessionEntry> = {};
  for (const [sessionKey, entry] of Object.entries(params.store)) {
    if (!entry) {
      continue;
    }
    normalizedStore[normalizeStoreSessionKey(sessionKey)] = normalizeSessionEntryDelivery(
      normalizeSessionRuntimeModelFields(entry),
    );
  }
  normalizeSessionStoreForSqlite(normalizedStore);

  const previousSerialized = new Map<string, string>();
  if (params.previousStore) {
    for (const [sessionKey, entry] of Object.entries(params.previousStore)) {
      if (!entry) {
        continue;
      }
      previousSerialized.set(normalizeStoreSessionKey(sessionKey), serializeSessionEntry(entry));
    }
  }

  withImmediateTransaction(database.db, () => {
    if (!params.previousStore) {
      database.statements.clearEntries.run();
    } else {
      for (const sessionKey of previousSerialized.keys()) {
        if (!Object.prototype.hasOwnProperty.call(normalizedStore, sessionKey)) {
          database.statements.deleteEntry.run(sessionKey);
        }
      }
    }

    for (const [sessionKey, entry] of Object.entries(normalizedStore)) {
      const serialized = serializeSessionEntry(entry);
      if (params.previousStore && previousSerialized.get(sessionKey) === serialized) {
        continue;
      }
      database.statements.upsertEntry.run({
        ...bindSessionEntry(sessionKey, entry),
        entry_json: serialized,
      });
    }
  });
}

export function closeSessionStoreSqliteDatabasesForTest(): void {
  for (const database of SESSION_STORE_DB_CACHE.values()) {
    database.db.close();
  }
  SESSION_STORE_DB_CACHE.clear();
}
