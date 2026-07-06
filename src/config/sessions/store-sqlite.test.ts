// SQLite session-store tests cover migration, hot row access, and JSON compatibility.
import { createHash } from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { MsgContext } from "../../auto-reply/templating.js";
import { requireNodeSqlite } from "../../infra/node-sqlite.js";
import { createSuiteTempRootTracker } from "../../test-helpers/temp-dir.js";
import { resolveStorePath } from "./paths.js";
import type { ResolvedSessionMaintenanceConfig } from "./store-maintenance.js";
import {
  getSessionStoreSqliteStatsForTest,
  inspectSessionStoreSqliteImportStateReadOnly,
  inspectSessionStoreSqliteReadOnly,
  resetSessionStoreSqliteStatsForTest,
  transformSessionStoreInSqliteForMigration,
  upsertSessionEntryInSqlite,
} from "./store-sqlite.js";
import {
  applySessionStoreEntryPatch,
  clearSessionStoreCacheForTest,
  getSqliteSessionDiskBudgetWarningCountForTest,
  loadSessionStore,
  patchSessionEntry,
  recordSessionMetaFromInbound,
  readSessionUpdatedAt,
  readSessionEntry,
  saveSessionStore,
  updateLastRoute,
  updateSessionStoreEntry,
  upsertSessionEntry,
} from "./store.js";
import type { SessionEntry } from "./types.js";

const suiteRootTracker = createSuiteTempRootTracker({ prefix: "openclaw-session-sqlite-" });

function entry(sessionId: string, updatedAt = 1): SessionEntry {
  return { sessionId, updatedAt };
}

function overwriteRawEntryJson(storePath: string, sessionKey: string, entryJson: string): void {
  const sqlite = requireNodeSqlite();
  const db = new sqlite.DatabaseSync(storePath);
  db.prepare("UPDATE session_entries SET entry_json = ? WHERE session_key = ?").run(
    entryJson,
    sessionKey,
  );
  db.close();
}

function readRawEntryJson(storePath: string, sessionKey: string): string | undefined {
  const sqlite = requireNodeSqlite();
  const db = new sqlite.DatabaseSync(storePath, { readOnly: true });
  const row = db
    .prepare("SELECT entry_json FROM session_entries WHERE session_key = ?")
    .get(sessionKey) as { entry_json: string } | undefined;
  db.close();
  return row?.entry_json;
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

  it("preserves JSON5 compatibility while importing a legacy store", async () => {
    const dir = await suiteRootTracker.make("json5-import");
    const jsonPath = path.join(dir, "sessions.json");
    const storePath = path.join(dir, "sessions.sqlite");
    const sessionKey = "agent:main:webchat:dm:json5-user";
    await fs.writeFile(
      jsonPath,
      `{
        // Hand-edited legacy stores historically allowed comments and trailing commas.
        "${sessionKey}": {
          "sessionId": "json5-imported",
          "updatedAt": 7,
        },
      }`,
      "utf8",
    );

    expect(readSessionEntry(storePath, sessionKey)).toMatchObject({
      sessionId: "json5-imported",
      updatedAt: 7,
    });
    const names = await fs.readdir(dir);
    expect(names).not.toContain("sessions.json");
    expect(names.some((name) => name.startsWith("sessions.json.bak."))).toBe(true);
  });

  it("keeps inbound metadata and route updates row-scoped for existing sessions", async () => {
    const dir = await suiteRootTracker.make("inbound-hot-writes");
    const storePath = path.join(dir, "sessions.sqlite");
    const sessionKey = "agent:main:signal:direct:user";
    await saveSessionStore(
      storePath,
      {
        [sessionKey]: entry("signal-session", 42),
        "agent:main:signal:direct:unrelated": entry("unrelated", 41),
      },
      { skipMaintenance: true },
    );

    clearSessionStoreCacheForTest();
    resetSessionStoreSqliteStatsForTest();
    await recordSessionMetaFromInbound({
      storePath,
      sessionKey,
      ctx: {
        Provider: "signal",
        Surface: "signal",
        ChatType: "direct",
        From: "+15555550100",
        To: "+15555550101",
      } as MsgContext,
    });
    await updateLastRoute({
      storePath,
      sessionKey,
      channel: "signal",
      to: "+15555550100",
    });

    expect(getSessionStoreSqliteStatsForTest()).toMatchObject({
      selectAll: 0,
      selectByKey: 2,
      upsert: 2,
    });
    expect(readSessionEntry(storePath, sessionKey)).toMatchObject({
      sessionId: "signal-session",
      updatedAt: 42,
      lastChannel: "signal",
      lastTo: "+15555550100",
      origin: { provider: "signal", chatType: "direct" },
    });
  });

  it("refuses hard-linked JSON imports without creating either SQLite authority", async () => {
    const dir = await suiteRootTracker.make("hardlink-json-import");
    const mainDir = path.join(dir, "main");
    const voiceDir = path.join(dir, "voice");
    await fs.mkdir(mainDir, { recursive: true });
    await fs.mkdir(voiceDir, { recursive: true });
    const mainJsonPath = path.join(mainDir, "sessions.json");
    const voiceJsonPath = path.join(voiceDir, "sessions.json");
    const mainStorePath = path.join(mainDir, "sessions.sqlite");
    const voiceStorePath = path.join(voiceDir, "sessions.sqlite");
    const raw = JSON.stringify({ shared: entry("shared") });
    await fs.writeFile(mainJsonPath, raw, "utf8");
    await fs.link(mainJsonPath, voiceJsonPath);

    expect(() => loadSessionStore(mainStorePath)).toThrow(
      "Refusing to import hard-linked legacy JSON session store",
    );
    expect(() => loadSessionStore(voiceStorePath)).toThrow(
      "Refusing to import hard-linked legacy JSON session store",
    );
    expect(inspectSessionStoreSqliteImportStateReadOnly(mainStorePath)).toEqual({
      entryCount: 0,
      jsonImportResolved: false,
    });
    expect(inspectSessionStoreSqliteImportStateReadOnly(voiceStorePath)).toEqual({
      entryCount: 0,
      jsonImportResolved: false,
    });
    await expect(fs.readFile(mainJsonPath, "utf8")).resolves.toBe(raw);
    await expect(fs.readFile(voiceJsonPath, "utf8")).resolves.toBe(raw);
  });

  it("refuses a final JSON symlink without creating an SQLite authority", async () => {
    if (process.platform === "win32") {
      return;
    }
    const dir = await suiteRootTracker.make("symlink-json-import");
    const sourcePath = path.join(dir, "shared-sessions.json");
    const jsonPath = path.join(dir, "sessions.json");
    const storePath = path.join(dir, "sessions.sqlite");
    const raw = JSON.stringify({ shared: entry("shared") });
    await fs.writeFile(sourcePath, raw, "utf8");
    await fs.symlink(sourcePath, jsonPath);

    expect(() => loadSessionStore(storePath)).toThrow(
      "Refusing to import aliased legacy JSON session store",
    );
    expect(inspectSessionStoreSqliteImportStateReadOnly(storePath)).toEqual({
      entryCount: 0,
      jsonImportResolved: false,
    });
    expect((await fs.lstat(jsonPath)).isSymbolicLink()).toBe(true);
    await expect(fs.readFile(sourcePath, "utf8")).resolves.toBe(raw);
  });

  it("retries a transient JSON archive rename failure in the same process", async () => {
    const dir = await suiteRootTracker.make("json-archive-retry");
    const jsonPath = path.join(dir, "sessions.json");
    const storePath = path.join(dir, "sessions.sqlite");
    const raw = JSON.stringify({ current: entry("current", 10) });
    await fs.writeFile(jsonPath, raw, "utf8");
    const originalRenameSync = fsSync.renameSync.bind(fsSync);
    const renameSpy = vi.spyOn(fsSync, "renameSync").mockImplementation((from, to) => {
      if (String(from) === jsonPath) {
        const error = new Error("temporary rename failure") as NodeJS.ErrnoException;
        error.code = "EBUSY";
        throw error;
      }
      originalRenameSync(from, to);
    });

    try {
      expect(loadSessionStore(storePath).current?.sessionId).toBe("current");
      await expect(fs.readFile(jsonPath, "utf8")).resolves.toBe(raw);
      expect(
        inspectSessionStoreSqliteImportStateReadOnly(storePath).jsonImportArchivePendingDigest,
      ).toBeDefined();
    } finally {
      renameSpy.mockRestore();
    }

    expect(loadSessionStore(storePath).current?.sessionId).toBe("current");
    const names = await fs.readdir(dir);
    expect(names).not.toContain("sessions.json");
    expect(names.some((name) => name.startsWith("sessions.json.bak."))).toBe(true);
    expect(
      inspectSessionStoreSqliteImportStateReadOnly(storePath).jsonImportArchivePendingDigest,
    ).toBeUndefined();
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

  it("does not import JSON that appears after an empty store was resolved", async () => {
    const dir = await suiteRootTracker.make("late-json");
    const jsonPath = path.join(dir, "sessions.json");
    const storePath = path.join(dir, "sessions.sqlite");
    const sessionKey = "agent:main:main";

    expect(loadSessionStore(storePath)).toEqual({});
    await fs.writeFile(jsonPath, JSON.stringify({ [sessionKey]: entry("late") }), "utf8");
    clearSessionStoreCacheForTest();

    expect(loadSessionStore(storePath)).toEqual({});
    await expect(fs.readFile(jsonPath, "utf8")).resolves.toContain("late");
  });

  it("keeps current SQLite rows when a migration fallback loses the import race", async () => {
    const dir = await suiteRootTracker.make("migration-race");
    const storePath = path.join(dir, "sessions.sqlite");
    await saveSessionStore(storePath, { current: entry("current", 10) }, { skipMaintenance: true });

    const transformed = transformSessionStoreInSqliteForMigration({
      storePath,
      fallbackStore: { stale: entry("stale", 1) },
      fallbackSourceDigest: "stale-digest",
      transform: (store) => ({
        store: { ...store, migrated: entry("migrated", 11) },
        result: Object.keys(store),
      }),
    });

    expect(transformed.adoptedFallbackStore).toBe(false);
    expect(transformed.jsonImportArchivePendingDigest).toBeUndefined();
    expect(transformed.result).toEqual(["current"]);
    expect(loadSessionStore(storePath, { skipCache: true })).toMatchObject({
      current: { sessionId: "current" },
      migrated: { sessionId: "migrated" },
    });
    expect(readSessionEntry(storePath, "stale")).toBeUndefined();
  });

  it("resumes JSON archival staged by a crashed importer", async () => {
    const dir = await suiteRootTracker.make("import-archive-restart");
    const jsonPath = path.join(dir, "sessions.json");
    const storePath = path.join(dir, "sessions.sqlite");
    const raw = JSON.stringify({ current: entry("current", 10) });
    await fs.writeFile(jsonPath, raw, "utf8");
    transformSessionStoreInSqliteForMigration({
      storePath,
      fallbackStore: { current: entry("current", 10) },
      fallbackSourceDigest: createHash("sha256").update(raw).digest("hex"),
      transform: (store) => ({ store, result: undefined }),
    });
    const stagedPath = `${jsonPath}.archive-pending.crashed-process`;
    await fs.rename(jsonPath, stagedPath);
    clearSessionStoreCacheForTest();

    expect(loadSessionStore(storePath).current?.sessionId).toBe("current");
    const names = await fs.readdir(dir);
    expect(names).not.toContain(path.basename(stagedPath));
    expect(names.some((name) => name.startsWith("sessions.json.bak."))).toBe(true);
    expect(
      inspectSessionStoreSqliteImportStateReadOnly(storePath).jsonImportArchivePendingDigest,
    ).toBeUndefined();
  });

  it("rejects corrupt migration rows instead of silently dropping them", async () => {
    const dir = await suiteRootTracker.make("strict-migration-read");
    const storePath = path.join(dir, "sessions.sqlite");
    await saveSessionStore(storePath, { corrupt: entry("corrupt") }, { skipMaintenance: true });
    clearSessionStoreCacheForTest();

    const sqlite = requireNodeSqlite();
    const db = new sqlite.DatabaseSync(storePath);
    db.prepare("UPDATE session_entries SET entry_json = ? WHERE session_key = ?").run(
      "{",
      "corrupt",
    );
    db.close();

    expect(() => inspectSessionStoreSqliteReadOnly(storePath)).toThrow(
      "invalid JSON for session key corrupt",
    );
    expect(() =>
      transformSessionStoreInSqliteForMigration({
        storePath,
        transform: (store) => ({ store, result: undefined }),
      }),
    ).toThrow("invalid JSON for session key corrupt");
  });

  it("fails closed when a full store read encounters malformed entry JSON", async () => {
    const dir = await suiteRootTracker.make("strict-full-read");
    const storePath = path.join(dir, "sessions.sqlite");
    await saveSessionStore(
      storePath,
      { healthy: entry("healthy"), corrupt: entry("corrupt") },
      { skipMaintenance: true },
    );
    clearSessionStoreCacheForTest();
    overwriteRawEntryJson(storePath, "corrupt", "{");

    expect(() => loadSessionStore(storePath, { skipCache: true })).toThrow(
      "invalid JSON for session key corrupt",
    );
  });

  it("fails closed when a point read encounters malformed entry JSON", async () => {
    const dir = await suiteRootTracker.make("strict-point-read");
    const storePath = path.join(dir, "sessions.sqlite");
    await saveSessionStore(storePath, { corrupt: entry("corrupt") }, { skipMaintenance: true });
    clearSessionStoreCacheForTest();
    overwriteRawEntryJson(storePath, "corrupt", "{");

    expect(() => readSessionEntry(storePath, "corrupt")).toThrow(
      "invalid JSON for session key corrupt",
    );
  });

  it("preserves malformed rows when an update requires a full store read", async () => {
    const dir = await suiteRootTracker.make("strict-update-read");
    const storePath = path.join(dir, "sessions.sqlite");
    await saveSessionStore(
      storePath,
      { healthy: entry("healthy"), corrupt: entry("corrupt") },
      { skipMaintenance: true },
    );
    clearSessionStoreCacheForTest();
    overwriteRawEntryJson(storePath, "corrupt", "{");

    await expect(
      updateSessionStoreEntry({
        storePath,
        sessionKey: "healthy",
        update: () => ({ updatedAt: 2 }),
      }),
    ).rejects.toThrow("invalid JSON for session key corrupt");

    clearSessionStoreCacheForTest();
    expect(readRawEntryJson(storePath, "corrupt")).toBe("{");
    expect(JSON.parse(readRawEntryJson(storePath, "healthy") ?? "null")).toMatchObject({
      sessionId: "healthy",
      updatedAt: 1,
    });
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

  it("keeps exact patch, apply, and replacement helpers row-scoped", async () => {
    const dir = await suiteRootTracker.make("exact-mutations");
    const storePath = path.join(dir, "sessions.sqlite");
    const sessionKey = "agent:main:main";
    const unrelatedKey = "agent:main:unrelated";
    await saveSessionStore(
      storePath,
      {
        [sessionKey]: { ...entry("target", 10), model: "old-model" },
        [unrelatedKey]: entry("unrelated", 20),
      },
      { skipMaintenance: true },
    );
    resetSessionStoreSqliteStatsForTest();

    const applied = await applySessionStoreEntryPatch({
      storePath,
      sessionKey,
      patch: { label: "applied" },
      skipMaintenance: true,
    });
    const patched = await patchSessionEntry({
      storePath,
      sessionKey,
      preserveActivity: true,
      skipMaintenance: true,
      update: (_entry, context) => ({
        displayName: context.existingEntry?.label,
      }),
    });
    await upsertSessionEntry({
      storePath,
      sessionKey,
      entry: { sessionId: "replacement", updatedAt: 30 },
      skipMaintenance: true,
    });

    expect(applied).toMatchObject({ label: "applied", sessionId: "target" });
    expect(patched).toMatchObject({
      displayName: "applied",
      label: "applied",
      sessionId: "target",
      updatedAt: applied?.updatedAt,
    });
    expect(getSessionStoreSqliteStatsForTest()).toMatchObject({
      selectAll: 0,
      selectByKey: 3,
      upsert: 3,
    });
    expect(readSessionEntry(storePath, sessionKey)).toEqual({
      sessionId: "replacement",
      updatedAt: 30,
    });
    expect(readSessionEntry(storePath, unrelatedKey)?.sessionId).toBe("unrelated");
  });

  it("uses the compatibility resolver for cold inserts and legacy aliases", async () => {
    const dir = await suiteRootTracker.make("exact-mutation-misses");
    const storePath = path.join(dir, "sessions.sqlite");
    const canonicalKey = "agent:main:main";
    const legacyKey = "AGENT:MAIN:MAIN";
    await saveSessionStore(storePath, { unrelated: entry("unrelated") }, { skipMaintenance: true });
    upsertSessionEntryInSqlite({
      storePath,
      sessionKey: legacyKey,
      entry: { sessionId: "legacy", updatedAt: 10 },
    });
    resetSessionStoreSqliteStatsForTest();

    await patchSessionEntry({
      storePath,
      sessionKey: canonicalKey,
      skipMaintenance: true,
      update: () => ({ label: "canonicalized" }),
    });

    expect(getSessionStoreSqliteStatsForTest()).toMatchObject({
      selectAll: 1,
      selectByKey: 1,
    });
    expect(readSessionEntry(storePath, canonicalKey)).toMatchObject({
      label: "canonicalized",
      sessionId: "legacy",
    });
    expect(readRawEntryJson(storePath, legacyKey)).toBeUndefined();

    resetSessionStoreSqliteStatsForTest();
    await upsertSessionEntry({
      storePath,
      sessionKey: "agent:main:new",
      entry: { sessionId: "new", updatedAt: 20 },
      skipMaintenance: true,
    });
    expect(getSessionStoreSqliteStatsForTest()).toMatchObject({
      selectAll: 1,
      selectByKey: 1,
    });
    expect(readSessionEntry(storePath, "agent:main:new")?.sessionId).toBe("new");
  });

  it("does not mutate a direct opaque-key row with mismatched delivery proof", async () => {
    const dir = await suiteRootTracker.make("exact-mutation-delivery-proof");
    const storePath = path.join(dir, "sessions.sqlite");
    const sessionKey = "agent:main:matrix:channel:!RoomABC:example.org";
    await saveSessionStore(
      storePath,
      {
        [sessionKey]: {
          lastTo: "!Different:example.org",
          sessionId: "wrong-target",
          updatedAt: 10,
        },
      },
      { skipMaintenance: true },
    );
    resetSessionStoreSqliteStatsForTest();

    const updated = await updateSessionStoreEntry({
      storePath,
      sessionKey,
      skipMaintenance: true,
      update: () => ({ label: "must-not-cross-targets" }),
    });

    expect(updated).toBeNull();
    expect(JSON.parse(readRawEntryJson(storePath, sessionKey) ?? "null")).toMatchObject({
      lastTo: "!Different:example.org",
      sessionId: "wrong-target",
    });
    expect(JSON.parse(readRawEntryJson(storePath, sessionKey) ?? "null")).not.toHaveProperty(
      "label",
    );
    expect(getSessionStoreSqliteStatsForTest()).toMatchObject({
      selectAll: 1,
      selectByKey: 1,
      upsert: 0,
    });
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
