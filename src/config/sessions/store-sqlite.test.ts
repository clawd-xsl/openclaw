// SQLite session-store tests cover migration, hot row access, and JSON compatibility.
import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { requireNodeSqlite } from "../../infra/node-sqlite.js";
import { createSuiteTempRootTracker } from "../../test-helpers/temp-dir.js";
import { resolveStorePath } from "./paths.js";
import type { ResolvedSessionMaintenanceConfig } from "./store-maintenance.js";
import {
  getSessionStoreSqliteStatsForTest,
  resetSessionStoreSqliteStatsForTest,
} from "./store-sqlite.js";
import {
  clearSessionStoreCacheForTest,
  getSqliteSessionDiskBudgetWarningCountForTest,
  loadSessionStore,
  readSessionUpdatedAt,
  readSessionEntry,
  saveSessionStore,
  updateSessionStoreEntry,
} from "./store.js";
import type { SessionEntry } from "./types.js";

const suiteRootTracker = createSuiteTempRootTracker({ prefix: "openclaw-session-sqlite-" });

function entry(sessionId: string, updatedAt = 1): SessionEntry {
  return { sessionId, updatedAt };
}

beforeAll(async () => {
  await suiteRootTracker.setup();
});

afterEach(() => {
  clearSessionStoreCacheForTest();
  resetSessionStoreSqliteStatsForTest();
});

afterAll(async () => {
  clearSessionStoreCacheForTest();
  await suiteRootTracker.cleanup();
});

describe("SQLite session store", () => {
  it("uses SQLite by default while explicit JSON stores remain file-backed", async () => {
    const stateDir = await suiteRootTracker.make("default-path");
    const defaultPath = resolveStorePath(undefined, {
      agentId: "main",
      env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
    });
    expect(defaultPath).toBe(path.join(stateDir, "agents", "main", "sessions", "sessions.sqlite"));

    const jsonPath = path.join(stateDir, "explicit-sessions.json");
    await saveSessionStore(jsonPath, { key: entry("json") }, { skipMaintenance: true });
    expect(JSON.parse(await fs.readFile(jsonPath, "utf8"))).toHaveProperty("key.sessionId", "json");
  });

  it("preserves exact case-sensitive opaque keys", async () => {
    const dir = await suiteRootTracker.make("exact-keys");
    const storePath = path.join(dir, "sessions.sqlite");
    const upper = "agent:main:matrix:channel:!AbC:example.org";
    const lower = "agent:main:matrix:channel:!abc:example.org";

    await saveSessionStore(
      storePath,
      { [upper]: entry("upper"), [lower]: entry("lower") },
      { skipMaintenance: true },
    );

    expect(readSessionEntry(storePath, upper)?.sessionId).toBe("upper");
    expect(readSessionEntry(storePath, lower)?.sessionId).toBe("lower");
    expect(Object.keys(loadSessionStore(storePath))).toEqual([upper, lower]);
  });

  it("imports current JSON once into an empty DB, archives it, then uses point reads", async () => {
    const dir = await suiteRootTracker.make("json-import");
    const jsonPath = path.join(dir, "sessions.json");
    const storePath = path.join(dir, "sessions.sqlite");
    const sessionKey = "agent:main:webchat:dm:user";
    await fs.writeFile(jsonPath, JSON.stringify({ [sessionKey]: entry("imported", 4) }), "utf8");

    expect(readSessionEntry(storePath, sessionKey)?.sessionId).toBe("imported");
    const names = await fs.readdir(dir);
    expect(names).not.toContain("sessions.json");
    expect(names.some((name) => name.startsWith("sessions.json.bak."))).toBe(true);

    resetSessionStoreSqliteStatsForTest();
    expect(readSessionEntry(storePath, sessionKey)?.updatedAt).toBe(4);
    expect(readSessionEntry(storePath, sessionKey)?.updatedAt).toBe(4);
    expect(getSessionStoreSqliteStatsForTest()).toMatchObject({
      selectAll: 0,
      selectByKey: 2,
    });
  });

  it("reads updatedAt from the keyed SQLite column", async () => {
    const dir = await suiteRootTracker.make("updated-at");
    const storePath = path.join(dir, "sessions.sqlite");
    const sessionKey = "agent:main:main";
    await saveSessionStore(
      storePath,
      { [sessionKey]: entry("updated", 42) },
      {
        skipMaintenance: true,
      },
    );
    resetSessionStoreSqliteStatsForTest();

    expect(readSessionUpdatedAt({ storePath, sessionKey })).toBe(42);
    expect(getSessionStoreSqliteStatsForTest()).toMatchObject({
      selectAll: 0,
      selectByKey: 0,
      selectUpdatedAt: 1,
    });
  });

  it("keeps a non-empty legacy custom DB authoritative over stale JSON", async () => {
    const dir = await suiteRootTracker.make("db-wins");
    const storePath = path.join(dir, "sessions.sqlite");
    const jsonPath = path.join(dir, "sessions.json");
    const sessionKey = "agent:main:main";
    await saveSessionStore(
      storePath,
      { [sessionKey]: entry("sqlite-current", 10) },
      { skipMaintenance: true },
    );
    await fs.writeFile(jsonPath, JSON.stringify({ [sessionKey]: entry("json-stale", 1) }), "utf8");
    clearSessionStoreCacheForTest();

    expect(readSessionEntry(storePath, sessionKey)?.sessionId).toBe("sqlite-current");
    expect(await fs.readFile(jsonPath, "utf8")).toContain("json-stale");
  });

  it("does not resolve the import marker when legacy JSON is malformed", async () => {
    const dir = await suiteRootTracker.make("json-import-retry");
    const jsonPath = path.join(dir, "sessions.json");
    const storePath = path.join(dir, "sessions.sqlite");
    const sessionKey = "agent:main:main";
    await fs.writeFile(jsonPath, "{", "utf8");

    expect(() => readSessionEntry(storePath, sessionKey)).toThrow(
      "Failed to parse legacy JSON session store",
    );
    await fs.writeFile(jsonPath, JSON.stringify({ [sessionKey]: entry("recovered") }), "utf8");

    expect(readSessionEntry(storePath, sessionKey)?.sessionId).toBe("recovered");
  });

  it("migrates the legacy normalized_key schema without folding future keys", async () => {
    const dir = await suiteRootTracker.make("legacy-schema");
    const storePath = path.join(dir, "sessions.sqlite");
    const sqlite = requireNodeSqlite();
    const db = new sqlite.DatabaseSync(storePath);
    db.exec(`
      CREATE TABLE session_entries (
        session_key TEXT PRIMARY KEY,
        normalized_key TEXT NOT NULL UNIQUE,
        session_id TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        created_at INTEGER,
        entry_json TEXT NOT NULL
      )
    `);
    const legacyKey = "agent:main:main";
    db.prepare(
      "INSERT INTO session_entries (session_key, normalized_key, session_id, updated_at, created_at, entry_json) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(legacyKey, legacyKey, "legacy", 3, null, JSON.stringify(entry("legacy", 3)));
    db.close();

    expect(readSessionEntry(storePath, legacyKey)?.sessionId).toBe("legacy");
    clearSessionStoreCacheForTest();
    const migrated = new sqlite.DatabaseSync(storePath, { readOnly: true });
    const columns = migrated.prepare("PRAGMA table_info(session_entries)").all() as Array<{
      name: string;
    }>;
    migrated.close();
    expect(columns.map((column) => column.name)).not.toContain("normalized_key");
  });

  it("hydrates content-addressed skill prompts from SQLite rows", async () => {
    const dir = await suiteRootTracker.make("prompt-blob");
    const storePath = path.join(dir, "sessions.sqlite");
    const sessionKey = "agent:main:main";
    const prompt = "prompt:" + "x".repeat(800);
    await saveSessionStore(
      storePath,
      {
        [sessionKey]: {
          ...entry("prompt"),
          skillsSnapshot: { prompt, skills: [{ name: "example" }], version: 1 },
        },
      },
      { skipMaintenance: true },
    );

    clearSessionStoreCacheForTest();
    expect(readSessionEntry(storePath, sessionKey)?.skillsSnapshot?.prompt).toBe(prompt);
    clearSessionStoreCacheForTest();
    const sqlite = requireNodeSqlite();
    const db = new sqlite.DatabaseSync(storePath, { readOnly: true });
    const row = db
      .prepare("SELECT entry_json FROM session_entries WHERE session_key = ?")
      .get(sessionKey) as { entry_json: string };
    db.close();
    expect(row.entry_json).not.toContain(prompt);
    expect(row.entry_json).toContain("promptRef");
  });

  it("serializes concurrent hot updates and upserts only the touched row", async () => {
    const dir = await suiteRootTracker.make("concurrent-update");
    const storePath = path.join(dir, "sessions.sqlite");
    const sessionKey = "agent:main:main";
    await saveSessionStore(
      storePath,
      { [sessionKey]: { ...entry("counter"), compactionCount: 0 } },
      { skipMaintenance: true },
    );
    resetSessionStoreSqliteStatsForTest();

    await Promise.all(
      [1, 2].map(() =>
        updateSessionStoreEntry({
          storePath,
          sessionKey,
          skipMaintenance: true,
          update: (current) => ({
            compactionCount: (current.compactionCount ?? 0) + 1,
            pendingFinalDeliveryAttemptCount: -1,
          }),
        }),
      ),
    );

    const persisted = readSessionEntry(storePath, sessionKey);
    expect(persisted?.compactionCount).toBe(2);
    expect(persisted?.pendingFinalDeliveryAttemptCount).toBeUndefined();
    expect(getSessionStoreSqliteStatsForTest()).toMatchObject({ selectAll: 0, upsert: 2 });
  });

  it("disables JSON-sized disk eviction for SQLite and warns once", async () => {
    const dir = await suiteRootTracker.make("disk-budget");
    const storePath = path.join(dir, "sessions.sqlite");
    const beforeWarnings = getSqliteSessionDiskBudgetWarningCountForTest();
    const maintenanceConfig: ResolvedSessionMaintenanceConfig = {
      mode: "enforce",
      pruneAfterMs: Number.MAX_SAFE_INTEGER,
      maxEntries: 500,
      modelRunPruneAfterMs: Number.MAX_SAFE_INTEGER,
      resetArchiveRetentionMs: null,
      maxDiskBytes: 1,
      highWaterBytes: 1,
    };
    await saveSessionStore(storePath, { key: entry("kept") }, { maintenanceConfig });
    await saveSessionStore(storePath, { key: entry("kept", 2) }, { maintenanceConfig });

    expect(readSessionEntry(storePath, "key")?.sessionId).toBe("kept");
    expect(getSqliteSessionDiskBudgetWarningCountForTest()).toBe(beforeWarnings + 1);
  });

  it("uses WAL with private files and releases the handle on cache clear", async () => {
    const dir = await suiteRootTracker.make("wal-close");
    const storePath = path.join(dir, "sessions.sqlite");
    await saveSessionStore(storePath, { key: entry("wal") }, { skipMaintenance: true });
    const stat = await fs.stat(storePath);
    if (process.platform !== "win32") {
      expect(stat.mode & 0o777).toBe(0o600);
    }
    const sqlite = requireNodeSqlite();
    const readOnly = new sqlite.DatabaseSync(storePath, { readOnly: true });
    expect(
      (readOnly.prepare("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode,
    ).toBe("wal");
    readOnly.close();

    clearSessionStoreCacheForTest();
    const movedPath = `${storePath}.closed`;
    await fs.rename(storePath, movedPath);
    expect((await fs.stat(movedPath)).isFile()).toBe(true);
  });
});
