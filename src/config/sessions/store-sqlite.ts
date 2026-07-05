// SQLite session-store backend. JSON stores remain available when explicitly configured.
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
  clearNodeSqliteKyselyCacheForDatabase,
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../../infra/kysely-sync.js";
import { requireNodeSqlite } from "../../infra/node-sqlite.js";
import { resolveSqliteDatabaseFilePaths } from "../../infra/sqlite-files.js";
import { runSqliteImmediateTransactionSync } from "../../infra/sqlite-transaction.js";
import {
  configureSqliteConnectionPragmas,
  type SqliteWalMaintenance,
} from "../../infra/sqlite-wal.js";
import { OPENCLAW_SQLITE_BUSY_TIMEOUT_MS } from "../../state/openclaw-state-db.js";
import type { SessionEntry } from "./types.js";

type SessionEntriesTable = {
  session_key: string;
  session_id: string;
  updated_at: number;
  created_at: number | null;
  entry_json: string;
};

type SessionStoreMetaTable = {
  meta_key: string;
  value_text: string;
  updated_at: number;
};

type SessionStoreDatabase = {
  session_entries: SessionEntriesTable;
  session_store_meta: SessionStoreMetaTable;
};

type SessionStoreHandle = {
  db: DatabaseSync;
  importResolved: boolean;
  path: string;
  walMaintenance: SqliteWalMaintenance;
};

type PersistedSessionEntry = {
  sessionKey: string;
  entry: SessionEntry;
  serialized: string;
};

const SESSION_STORE_SCHEMA_VERSION = 1;
const SESSION_STORE_DIR_MODE = 0o700;
const SESSION_STORE_FILE_MODE = 0o600;
const JSON_IMPORT_META_KEY = "json-import-v1";
const handles = new Map<string, SessionStoreHandle>();
const testStats = {
  selectAll: 0,
  selectByKey: 0,
  selectUpdatedAt: 0,
  upsert: 0,
};

export function isSqliteSessionStorePath(storePath: string): boolean {
  const extension = path.extname(storePath).toLowerCase();
  return extension === ".sqlite" || extension === ".db";
}

export function resolveSessionStoreJsonImportPath(storePath: string): string {
  const extension = path.extname(storePath);
  return `${storePath.slice(0, -extension.length)}.json`;
}

function hardenDatabaseFiles(databasePath: string): void {
  for (const candidate of resolveSqliteDatabaseFilePaths(databasePath)) {
    if (existsSync(candidate)) {
      chmodSync(candidate, SESSION_STORE_FILE_MODE);
    }
  }
}

function sessionEntriesTableColumns(db: DatabaseSync): Set<string> {
  return new Set(
    (db.prepare("PRAGMA table_info(session_entries)").all() as Array<{ name?: unknown }>)
      .map((row) => (typeof row.name === "string" ? row.name : ""))
      .filter(Boolean),
  );
}

function createCurrentSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS session_entries (
      session_key TEXT NOT NULL PRIMARY KEY COLLATE BINARY,
      session_id TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      created_at INTEGER,
      entry_json TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_session_entries_session_id
      ON session_entries(session_id);
    CREATE INDEX IF NOT EXISTS idx_session_entries_updated_at
      ON session_entries(updated_at DESC, session_key ASC);

    CREATE TABLE IF NOT EXISTS session_store_meta (
      meta_key TEXT NOT NULL PRIMARY KEY,
      value_text TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
}

function migrateLegacyCustomSchema(db: DatabaseSync): void {
  runSqliteImmediateTransactionSync(db, () => {
    // Recheck after acquiring the writer lock: another process may have completed this migration
    // while this connection was waiting to enter its first transaction.
    const columns = sessionEntriesTableColumns(db);
    if (!columns.has("normalized_key")) {
      return;
    }
    // The old custom backend folded every key before persistence. Preserve the bytes that remain,
    // but remove the UNIQUE normalized-key column so new opaque peer ids stay case-sensitive.
    db.exec("ALTER TABLE session_entries RENAME TO session_entries_legacy_custom");
    db.exec(`
      CREATE TABLE session_entries (
        session_key TEXT NOT NULL PRIMARY KEY COLLATE BINARY,
        session_id TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        created_at INTEGER,
        entry_json TEXT NOT NULL
      )
    `);
    db.exec(`
      INSERT INTO session_entries (session_key, session_id, updated_at, created_at, entry_json)
      SELECT session_key, session_id, updated_at, created_at, entry_json
      FROM session_entries_legacy_custom
    `);
    db.exec("DROP TABLE session_entries_legacy_custom");
  });
}

function ensureSchema(db: DatabaseSync, databasePath: string): void {
  const userVersion = Number(
    (db.prepare("PRAGMA user_version").get() as { user_version?: number } | undefined)
      ?.user_version ?? 0,
  );
  if (userVersion > SESSION_STORE_SCHEMA_VERSION) {
    throw new Error(
      `Session store ${databasePath} uses newer schema version ${userVersion}; this build supports ${SESSION_STORE_SCHEMA_VERSION}.`,
    );
  }
  const hasSessionEntries =
    db
      .prepare(
        "SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'session_entries'",
      )
      .get() !== undefined;
  if (hasSessionEntries) {
    migrateLegacyCustomSchema(db);
  }
  createCurrentSchema(db);
  db.exec(`PRAGMA user_version = ${SESSION_STORE_SCHEMA_VERSION}`);
}

function hasResolvedJsonImport(db: DatabaseSync): boolean {
  const kysely = getNodeSqliteKysely<SessionStoreDatabase>(db);
  return (
    executeSqliteQueryTakeFirstSync(
      db,
      kysely
        .selectFrom("session_store_meta")
        .select("value_text")
        .where("meta_key", "=", JSON_IMPORT_META_KEY),
    )?.value_text === "resolved"
  );
}

function writeResolvedJsonImport(db: DatabaseSync): void {
  const kysely = getNodeSqliteKysely<SessionStoreDatabase>(db);
  executeSqliteQuerySync(
    db,
    kysely
      .insertInto("session_store_meta")
      .values({ meta_key: JSON_IMPORT_META_KEY, value_text: "resolved", updated_at: Date.now() })
      .onConflict((conflict) =>
        conflict.column("meta_key").doUpdateSet({
          value_text: "resolved",
          updated_at: Date.now(),
        }),
      ),
  );
}

function openSessionStore(storePath: string): SessionStoreHandle {
  const databasePath = path.resolve(storePath);
  const cached = handles.get(databasePath);
  if (cached?.db.isOpen) {
    return cached;
  }
  if (cached) {
    cached.walMaintenance.close();
    clearNodeSqliteKyselyCacheForDatabase(cached.db);
    handles.delete(databasePath);
  }

  mkdirSync(path.dirname(databasePath), { recursive: true, mode: SESSION_STORE_DIR_MODE });
  const sqlite = requireNodeSqlite();
  const db = new sqlite.DatabaseSync(databasePath);
  let walMaintenance: SqliteWalMaintenance | undefined;
  try {
    walMaintenance = configureSqliteConnectionPragmas(db, {
      busyTimeoutMs: OPENCLAW_SQLITE_BUSY_TIMEOUT_MS,
      databaseLabel: "session store",
      databasePath,
      synchronous: "NORMAL",
    });
    ensureSchema(db, databasePath);
    hardenDatabaseFiles(databasePath);
  } catch (error) {
    walMaintenance?.close();
    db.close();
    throw error;
  }
  if (!walMaintenance) {
    db.close();
    throw new Error(
      `Failed to initialize SQLite WAL maintenance for session store ${databasePath}`,
    );
  }
  const handle = {
    db,
    importResolved: hasResolvedJsonImport(db),
    path: databasePath,
    walMaintenance,
  };
  handles.set(databasePath, handle);
  return handle;
}

function parseEntry(serialized: string): SessionEntry | undefined {
  try {
    const parsed = JSON.parse(serialized) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as SessionEntry)
      : undefined;
  } catch {
    return undefined;
  }
}

export function countSessionStoreSqliteEntries(storePath: string): number {
  const { db } = openSessionStore(storePath);
  const kysely = getNodeSqliteKysely<SessionStoreDatabase>(db);
  const row = executeSqliteQueryTakeFirstSync(
    db,
    kysely.selectFrom("session_entries").select((eb) => eb.fn.countAll<number>().as("count")),
  );
  return Number(row?.count ?? 0);
}

export function isSessionStoreSqliteJsonImportResolved(storePath: string): boolean {
  return openSessionStore(storePath).importResolved;
}

export function markSessionStoreSqliteJsonImportResolved(storePath: string): void {
  const handle = openSessionStore(storePath);
  if (handle.importResolved) {
    return;
  }
  runSqliteImmediateTransactionSync(handle.db, () => writeResolvedJsonImport(handle.db));
  handle.importResolved = true;
}

export function loadSessionStoreFromSqlite(storePath: string): Record<string, SessionEntry> {
  const { db } = openSessionStore(storePath);
  const kysely = getNodeSqliteKysely<SessionStoreDatabase>(db);
  testStats.selectAll += 1;
  const rows = executeSqliteQuerySync(
    db,
    kysely
      .selectFrom("session_entries")
      .select(["session_key", "entry_json"])
      .orderBy("updated_at", "desc")
      .orderBy("session_key", "asc"),
  ).rows;
  const store: Record<string, SessionEntry> = {};
  for (const row of rows) {
    const entry = parseEntry(row.entry_json);
    if (entry) {
      store[row.session_key] = entry;
    }
  }
  return store;
}

export function loadSessionEntryFromSqlite(
  storePath: string,
  sessionKey: string,
): SessionEntry | undefined {
  const { db } = openSessionStore(storePath);
  const kysely = getNodeSqliteKysely<SessionStoreDatabase>(db);
  testStats.selectByKey += 1;
  const row = executeSqliteQueryTakeFirstSync(
    db,
    kysely.selectFrom("session_entries").select("entry_json").where("session_key", "=", sessionKey),
  );
  return row ? parseEntry(row.entry_json) : undefined;
}

export function readSessionUpdatedAtFromSqlite(
  storePath: string,
  sessionKey: string,
): number | undefined {
  const { db } = openSessionStore(storePath);
  const kysely = getNodeSqliteKysely<SessionStoreDatabase>(db);
  testStats.selectUpdatedAt += 1;
  const row = executeSqliteQueryTakeFirstSync(
    db,
    kysely.selectFrom("session_entries").select("updated_at").where("session_key", "=", sessionKey),
  );
  return row?.updated_at;
}

function toPersistedEntry(sessionKey: string, entry: SessionEntry): PersistedSessionEntry {
  return {
    sessionKey,
    entry,
    serialized: JSON.stringify(entry),
  };
}

function resolveEntryCreatedAt(entry: SessionEntry): number | null {
  const createdAt = (entry as SessionEntry & { createdAt?: unknown }).createdAt;
  return typeof createdAt === "number" && Number.isFinite(createdAt) ? createdAt : null;
}

function upsertPersistedEntries(db: DatabaseSync, entries: readonly PersistedSessionEntry[]): void {
  if (entries.length === 0) {
    return;
  }
  const kysely = getNodeSqliteKysely<SessionStoreDatabase>(db);
  const chunkSize = 200;
  for (let offset = 0; offset < entries.length; offset += chunkSize) {
    const chunk = entries.slice(offset, offset + chunkSize);
    testStats.upsert += chunk.length;
    executeSqliteQuerySync(
      db,
      kysely
        .insertInto("session_entries")
        .values(
          chunk.map(({ sessionKey, entry, serialized }) => ({
            session_key: sessionKey,
            session_id: entry.sessionId || sessionKey,
            updated_at: entry.updatedAt ?? Date.now(),
            created_at: resolveEntryCreatedAt(entry),
            entry_json: serialized,
          })),
        )
        .onConflict((conflict) =>
          conflict.column("session_key").doUpdateSet({
            session_id: (eb) => eb.ref("excluded.session_id"),
            updated_at: (eb) => eb.ref("excluded.updated_at"),
            created_at: (eb) => eb.ref("excluded.created_at"),
            entry_json: (eb) => eb.ref("excluded.entry_json"),
          }),
        ),
    );
  }
}

function deleteSessionKeys(db: DatabaseSync, sessionKeys: readonly string[]): void {
  if (sessionKeys.length === 0) {
    return;
  }
  const kysely = getNodeSqliteKysely<SessionStoreDatabase>(db);
  const chunkSize = 500;
  for (let offset = 0; offset < sessionKeys.length; offset += chunkSize) {
    executeSqliteQuerySync(
      db,
      kysely
        .deleteFrom("session_entries")
        .where("session_key", "in", sessionKeys.slice(offset, offset + chunkSize)),
    );
  }
}

export function upsertSessionEntryInSqlite(params: {
  storePath: string;
  sessionKey: string;
  entry: SessionEntry;
  deleteKeys?: readonly string[];
}): void {
  const { db } = openSessionStore(params.storePath);
  runSqliteImmediateTransactionSync(db, () => {
    upsertPersistedEntries(db, [toPersistedEntry(params.sessionKey, params.entry)]);
    const deleteKeys = [...new Set(params.deleteKeys ?? [])].filter(
      (key) => key !== params.sessionKey,
    );
    deleteSessionKeys(db, deleteKeys);
  });
  hardenDatabaseFiles(path.resolve(params.storePath));
}

export function saveSessionStoreToSqlite(
  storePath: string,
  store: Record<string, SessionEntry>,
): void {
  const { db } = openSessionStore(storePath);
  const entries = Object.entries(store).map(([sessionKey, entry]) =>
    toPersistedEntry(sessionKey, entry),
  );
  runSqliteImmediateTransactionSync(db, () => {
    const kysely = getNodeSqliteKysely<SessionStoreDatabase>(db);
    const existing = new Map(
      executeSqliteQuerySync(
        db,
        kysely.selectFrom("session_entries").select(["session_key", "entry_json"]),
      ).rows.map((row) => [row.session_key, row.entry_json]),
    );
    const nextKeys = new Set(entries.map((entry) => entry.sessionKey));
    const removedKeys = [...existing.keys()].filter((key) => !nextKeys.has(key));
    deleteSessionKeys(db, removedKeys);
    upsertPersistedEntries(
      db,
      entries.filter((entry) => existing.get(entry.sessionKey) !== entry.serialized),
    );
  });
  hardenDatabaseFiles(path.resolve(storePath));
}

export function importSessionStoreIntoEmptySqlite(
  storePath: string,
  store: Record<string, SessionEntry>,
): boolean {
  const { db } = openSessionStore(storePath);
  const entries = Object.entries(store).map(([sessionKey, entry]) =>
    toPersistedEntry(sessionKey, entry),
  );
  const imported = runSqliteImmediateTransactionSync(db, () => {
    const kysely = getNodeSqliteKysely<SessionStoreDatabase>(db);
    const existing = executeSqliteQueryTakeFirstSync(
      db,
      kysely.selectFrom("session_entries").select((eb) => eb.fn.countAll<number>().as("count")),
    );
    if (Number(existing?.count ?? 0) > 0) {
      return false;
    }
    upsertPersistedEntries(db, entries);
    writeResolvedJsonImport(db);
    return true;
  });
  if (imported) {
    openSessionStore(storePath).importResolved = true;
  }
  return imported;
}

export function getSessionStoreSqliteStatsForTest(): Readonly<typeof testStats> {
  return { ...testStats };
}

export function resetSessionStoreSqliteStatsForTest(): void {
  testStats.selectAll = 0;
  testStats.selectByKey = 0;
  testStats.selectUpdatedAt = 0;
  testStats.upsert = 0;
}

export function closeSessionStoreSqliteDatabasesForTest(): void {
  for (const handle of handles.values()) {
    handle.walMaintenance.close();
    clearNodeSqliteKyselyCacheForDatabase(handle.db);
    handle.db.close();
  }
  handles.clear();
}
