import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as jsonFiles from "../infra/json-files.js";
import {
  clearSessionStoreCacheForTest,
  cleanupSessionLifecycleArtifacts,
  deleteSessionEntries,
  getSessionEntry,
  inspectSessionStoreEntriesReadOnly,
  listSessionEntries,
  patchSessionEntry,
  readSessionUpdatedAt,
  saveSessionStore,
  updateSessionStore,
  updateSessionStoreEntry,
  upsertSessionEntry,
} from "./session-store-runtime.js";

const DAY_MS = 24 * 60 * 60 * 1000;

describe("session-store-runtime compatibility surface", () => {
  let tempDir: string;
  let storePath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-sdk-session-store-"));
    storePath = path.join(tempDir, "sessions.json");
  });

  afterEach(() => {
    clearSessionStoreCacheForTest();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("keeps the public session read shape while using accessor-backed exports", async () => {
    const sessionKey = "agent:main:main";
    await upsertSessionEntry({
      sessionKey,
      storePath,
      entry: {
        model: "gpt-5.5",
        sessionId: "session-1",
        updatedAt: 10,
      },
    });

    expect(getSessionEntry({ sessionKey, storePath })).toMatchObject({
      model: "gpt-5.5",
      sessionId: "session-1",
      updatedAt: 10,
    });
    expect(readSessionUpdatedAt({ sessionKey, storePath })).toEqual(expect.any(Number));
    expect(listSessionEntries({ storePath })).toEqual([
      {
        sessionKey,
        entry: expect.objectContaining({
          model: "gpt-5.5",
          sessionId: "session-1",
          updatedAt: 10,
        }),
      },
    ]);

    await upsertSessionEntry({
      sessionKey,
      storePath,
      entry: {
        sessionId: "session-1",
        updatedAt: 20,
      },
    });
    expect(getSessionEntry({ sessionKey, storePath })?.model).toBeUndefined();
  });

  it("inspects a pending SQLite import without creating or archiving files", () => {
    const sqlitePath = path.join(tempDir, "sessions.sqlite");
    const jsonPath = path.join(tempDir, "sessions.json");
    const sessionKey = "agent:main:feishu:direct:ou_user";
    const raw = JSON.stringify({
      [sessionKey]: {
        sessionId: "legacy-session",
        updatedAt: 10,
      },
    });
    fs.writeFileSync(jsonPath, raw);
    const namesBefore = fs.readdirSync(tempDir).toSorted();

    expect(inspectSessionStoreEntriesReadOnly({ storePath: sqlitePath })).toEqual([
      {
        sessionKey,
        entry: expect.objectContaining({ sessionId: "legacy-session" }),
      },
    ]);

    expect(fs.readdirSync(tempDir).toSorted()).toEqual(namesBefore);
    expect(fs.existsSync(sqlitePath)).toBe(false);
    expect(fs.readFileSync(jsonPath, "utf8")).toBe(raw);
  });

  it("deletes only named SQLite rows added after a read-only inspection", async () => {
    const sqlitePath = path.join(tempDir, "sessions.sqlite");
    const targetKey = "agent:main:feishu:direct:ou_user";
    const existingKey = "agent:main:discord:direct:user";
    const concurrentKey = "agent:main:slack:direct:user";
    await saveSessionStore(
      sqlitePath,
      {
        [targetKey]: { sessionId: "target", updatedAt: 10 },
        [existingKey]: { sessionId: "existing", updatedAt: 20 },
      },
      { skipMaintenance: true },
    );
    expect(
      inspectSessionStoreEntriesReadOnly({ storePath: sqlitePath }).map(
        (entry) => entry.sessionKey,
      ),
    ).not.toContain(concurrentKey);

    const concurrentDb = new DatabaseSync(sqlitePath);
    const concurrentEntry = { sessionId: "concurrent", updatedAt: 30 };
    concurrentDb
      .prepare(
        `INSERT INTO session_entries
          (session_key, session_id, updated_at, created_at, entry_json)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        concurrentKey,
        concurrentEntry.sessionId,
        concurrentEntry.updatedAt,
        concurrentEntry.updatedAt,
        JSON.stringify(concurrentEntry),
      );
    concurrentDb.close();

    await expect(
      deleteSessionEntries({
        storePath: sqlitePath,
        targets: [{ sessionKey: targetKey, expectedSessionId: "target" }],
      }),
    ).resolves.toEqual([
      {
        sessionKey: targetKey,
        entry: expect.objectContaining({ sessionId: "target" }),
      },
    ]);
    expect(getSessionEntry({ storePath: sqlitePath, sessionKey: targetKey })).toBeUndefined();
    expect(getSessionEntry({ storePath: sqlitePath, sessionKey: existingKey })?.sessionId).toBe(
      "existing",
    );
    expect(getSessionEntry({ storePath: sqlitePath, sessionKey: concurrentKey })?.sessionId).toBe(
      "concurrent",
    );
  });

  it("keeps a same-key SQLite replacement when its inspected session identity is stale", async () => {
    const sqlitePath = path.join(tempDir, "sessions.sqlite");
    const targetKey = "agent:main:feishu:direct:ou_user";
    await saveSessionStore(
      sqlitePath,
      { [targetKey]: { sessionId: "inspected", updatedAt: 10 } },
      { skipMaintenance: true },
    );
    const inspected = inspectSessionStoreEntriesReadOnly({ storePath: sqlitePath });
    expect(inspected[0]?.entry.sessionId).toBe("inspected");

    const replacementDb = new DatabaseSync(sqlitePath);
    const replacementEntry = { sessionId: "replacement", updatedAt: 20 };
    replacementDb
      .prepare(
        `UPDATE session_entries
         SET session_id = ?, updated_at = ?, entry_json = ?
         WHERE session_key = ?`,
      )
      .run(
        replacementEntry.sessionId,
        replacementEntry.updatedAt,
        JSON.stringify(replacementEntry),
        targetKey,
      );
    replacementDb.close();

    await expect(
      deleteSessionEntries({
        storePath: sqlitePath,
        targets: [{ sessionKey: targetKey, expectedSessionId: "inspected" }],
      }),
    ).resolves.toEqual([]);
    expect(getSessionEntry({ storePath: sqlitePath, sessionKey: targetKey })?.sessionId).toBe(
      "replacement",
    );
  });

  it("keeps the public entry mutation signature while delegating to the seam", async () => {
    const sessionKey = "agent:main:main";

    await expect(
      updateSessionStoreEntry({
        sessionKey,
        storePath,
        update: () => ({ model: "gpt-5.5" }),
      }),
    ).resolves.toBeNull();

    await upsertSessionEntry({
      sessionKey,
      storePath,
      entry: {
        sessionId: "session-1",
        updatedAt: 10,
      },
    });

    const beforePatch = getSessionEntry({ sessionKey, storePath });
    await expect(
      patchSessionEntry({
        sessionKey,
        storePath,
        preserveActivity: true,
        update: (_entry, context) => ({
          providerOverride: context.existingEntry ? "openai" : "missing",
          updatedAt: 20,
        }),
      }),
    ).resolves.toMatchObject({
      providerOverride: "openai",
      sessionId: "session-1",
      updatedAt: beforePatch?.updatedAt,
    });

    await expect(
      updateSessionStoreEntry({
        sessionKey,
        storePath,
        update: () => ({ model: "gpt-5.5" }),
      }),
    ).resolves.toMatchObject({
      model: "gpt-5.5",
      providerOverride: "openai",
      sessionId: "session-1",
    });
  });

  it("deletes only named JSON entries and returns the removed row", async () => {
    const targetKey = "agent:main:feishu:direct:ou_user";
    const preservedKey = "agent:main:discord:direct:user";
    await saveSessionStore(
      storePath,
      {
        [targetKey]: { sessionId: "target", updatedAt: 10 },
        [preservedKey]: { sessionId: "preserved", updatedAt: 20 },
      },
      { skipMaintenance: true },
    );

    await expect(
      deleteSessionEntries({
        storePath,
        targets: [{ sessionKey: targetKey, expectedSessionId: "stale-inspection" }],
      }),
    ).resolves.toEqual([]);
    expect(getSessionEntry({ storePath, sessionKey: targetKey })?.sessionId).toBe("target");

    await expect(
      deleteSessionEntries({
        storePath,
        targets: [{ sessionKey: targetKey, expectedSessionId: "target" }],
      }),
    ).resolves.toEqual([
      {
        sessionKey: targetKey,
        entry: expect.objectContaining({ sessionId: "target" }),
      },
    ]);
    expect(getSessionEntry({ storePath, sessionKey: targetKey })).toBeUndefined();
    expect(getSessionEntry({ storePath, sessionKey: preservedKey })?.sessionId).toBe("preserved");
  });

  it("preserves resolved maintenance settings through entry patches", async () => {
    const staleSessionKey = "agent:main:stale";
    const activeSessionKey = "agent:main:active";
    await saveSessionStore(
      storePath,
      {
        [staleSessionKey]: {
          sessionId: "session-stale",
          updatedAt: 10,
        },
        [activeSessionKey]: {
          sessionId: "session-active",
          updatedAt: 20,
        },
      },
      { skipMaintenance: true },
    );

    await expect(
      patchSessionEntry({
        sessionKey: activeSessionKey,
        storePath,
        maintenanceConfig: {
          mode: "enforce",
          pruneAfterMs: 7 * DAY_MS,
          modelRunPruneAfterMs: DAY_MS,
          maxEntries: 1,
          resetArchiveRetentionMs: 7 * DAY_MS,
          maxDiskBytes: null,
          highWaterBytes: null,
        },
        update: () => ({ model: "gpt-5.5" }),
      }),
    ).resolves.toMatchObject({
      model: "gpt-5.5",
      sessionId: "session-active",
    });

    expect(getSessionEntry({ sessionKey: activeSessionKey, storePath })).toMatchObject({
      model: "gpt-5.5",
      sessionId: "session-active",
    });
    expect(getSessionEntry({ sessionKey: staleSessionKey, storePath })).toBeUndefined();
  });

  it("accepts pre-model-run maintenance configs through entry patches", async () => {
    const staleModelRunKey = "agent:main:explicit:model-run-123e4567-e89b-12d3-a456-426614174000";
    const activeSessionKey = "agent:main:active";
    const now = Date.now();
    await saveSessionStore(
      storePath,
      {
        [staleModelRunKey]: {
          sessionId: "session-probe",
          updatedAt: now - 2 * DAY_MS,
        },
        [activeSessionKey]: {
          sessionId: "session-active",
          updatedAt: now,
        },
      },
      { skipMaintenance: true },
    );

    const legacyMaintenanceConfig = {
      mode: "enforce" as const,
      pruneAfterMs: 7 * DAY_MS,
      maxEntries: 500,
      resetArchiveRetentionMs: 7 * DAY_MS,
      maxDiskBytes: null,
      highWaterBytes: null,
    };

    await expect(
      patchSessionEntry({
        sessionKey: activeSessionKey,
        storePath,
        maintenanceConfig: legacyMaintenanceConfig,
        update: () => ({ model: "gpt-5.5" }),
      }),
    ).resolves.toMatchObject({
      model: "gpt-5.5",
      sessionId: "session-active",
    });

    expect(getSessionEntry({ sessionKey: staleModelRunKey, storePath })).toMatchObject({
      sessionId: "session-probe",
    });
  });

  it("keeps deprecated whole-store mutations grouped as one compatibility operation", async () => {
    const firstSessionKey = "agent:main:first";
    const secondSessionKey = "agent:main:second";
    const deletedSessionKey = "agent:main:deleted";
    await saveSessionStore(
      storePath,
      {
        [firstSessionKey]: {
          sessionId: "session-1",
          updatedAt: 10,
        },
        [secondSessionKey]: {
          sessionId: "session-2",
          updatedAt: 10,
        },
        [deletedSessionKey]: {
          sessionId: "session-3",
          updatedAt: 10,
        },
      },
      { skipMaintenance: true },
    );

    await expect(
      updateSessionStore(
        storePath,
        (store) => {
          const first = store[firstSessionKey];
          const second = store[secondSessionKey];
          if (!first || !second) {
            throw new Error("seed session entries missing");
          }
          store[firstSessionKey] = {
            ...first,
            model: "gpt-5.5",
            updatedAt: 20,
          };
          store[secondSessionKey] = {
            ...second,
            providerOverride: "openai",
            updatedAt: 30,
          };
          delete store[deletedSessionKey];
          return "whole-store-updated";
        },
        { skipMaintenance: true },
      ),
    ).resolves.toBe("whole-store-updated");

    expect(getSessionEntry({ sessionKey: firstSessionKey, storePath })).toMatchObject({
      model: "gpt-5.5",
      sessionId: "session-1",
      updatedAt: 20,
    });
    expect(getSessionEntry({ sessionKey: secondSessionKey, storePath })).toMatchObject({
      providerOverride: "openai",
      sessionId: "session-2",
      updatedAt: 30,
    });
    expect(getSessionEntry({ sessionKey: deletedSessionKey, storePath })).toBeUndefined();
  });

  it("preserves requireWriteSuccess for critical session entry updates", async () => {
    const sessionKey = "agent:main:main";
    await upsertSessionEntry({
      sessionKey,
      storePath,
      entry: {
        sessionId: "session-1",
        updatedAt: 10,
      },
    });
    const writeError = Object.assign(new Error("write failed"), { code: "ENOENT" });
    const writeSpy = vi.spyOn(jsonFiles, "writeTextAtomic").mockRejectedValue(writeError);

    try {
      await expect(
        updateSessionStoreEntry({
          sessionKey,
          storePath,
          requireWriteSuccess: true,
          update: () => ({ model: "gpt-5.5" }),
        }),
      ).rejects.toBe(writeError);
    } finally {
      writeSpy.mockRestore();
    }
  });

  it("cleans lifecycle artifacts through the accessor-backed SDK wrapper", async () => {
    const sessionKey = "agent:main:lifecycle-owned-old";
    const transcriptPath = path.join(tempDir, "lifecycle-owned-old.jsonl");
    await saveSessionStore(
      storePath,
      {
        [sessionKey]: {
          sessionFile: transcriptPath,
          sessionId: "lifecycle-owned-old",
          updatedAt: 10,
        },
        "agent:main:regular": {
          sessionId: "regular",
          updatedAt: 20,
        },
      },
      { skipMaintenance: true },
    );
    fs.writeFileSync(transcriptPath, '{"runId":"lifecycle-owned-old"}\n', "utf-8");
    const oldDate = new Date(Date.now() - 600_000);
    fs.utimesSync(transcriptPath, oldDate, oldDate);

    await expect(
      cleanupSessionLifecycleArtifacts({
        storePath,
        sessionKeySegmentPrefix: "lifecycle-owned-",
        transcriptContentMarker: '"runId":"lifecycle-owned-',
        orphanTranscriptMinAgeMs: 300_000,
      }),
    ).resolves.toEqual({
      archivedTranscriptArtifacts: 1,
      removedEntries: 1,
    });

    expect(getSessionEntry({ sessionKey, storePath })).toBeUndefined();
    expect(getSessionEntry({ sessionKey: "agent:main:regular", storePath })).toMatchObject({
      sessionId: "regular",
    });
    expect(
      fs
        .readdirSync(tempDir)
        .filter((file) => file.startsWith("lifecycle-owned-old.jsonl.deleted.")),
    ).toHaveLength(1);
  });
});
