// SQLite transcript tests guard point-read and row-scoped write behavior.
import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createSuiteTempRootTracker } from "../../test-helpers/temp-dir.js";
import {
  getSessionStoreSqliteStatsForTest,
  resetSessionStoreSqliteStatsForTest,
} from "./store-sqlite.js";
import { clearSessionStoreCacheForTest, readSessionEntry, saveSessionStore } from "./store.js";
import {
  appendAssistantMessageToSessionTranscript,
  readRecentUserAssistantTextForSession,
} from "./transcript.js";

const suiteRootTracker = createSuiteTempRootTracker({ prefix: "openclaw-transcript-sqlite-" });

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

describe("SQLite session transcripts", () => {
  it("keeps identity reads and first assistant append off whole-store scans", async () => {
    const sessionsDir = await suiteRootTracker.make("known-session");
    const storePath = path.join(sessionsDir, "sessions.sqlite");
    const sessionKey = "agent:main:main";
    await saveSessionStore(
      storePath,
      {
        [sessionKey]: { sessionId: "target-session", updatedAt: 10 },
        "agent:main:unrelated": { sessionId: "unrelated-session", updatedAt: 20 },
      },
      { skipMaintenance: true },
    );
    resetSessionStoreSqliteStatsForTest();

    await expect(readRecentUserAssistantTextForSession({ sessionKey, storePath })).resolves.toEqual(
      [],
    );
    expect(getSessionStoreSqliteStatsForTest()).toMatchObject({
      selectAll: 0,
      selectByKey: 1,
      upsert: 0,
    });

    resetSessionStoreSqliteStatsForTest();
    const appended = await appendAssistantMessageToSessionTranscript({
      agentId: "main",
      sessionKey,
      storePath,
      text: "row-scoped reply",
      updateMode: "none",
    });

    expect(appended.ok).toBe(true);
    expect(getSessionStoreSqliteStatsForTest()).toMatchObject({
      selectAll: 0,
      selectByKey: 3,
      upsert: 2,
    });
    if (!appended.ok) {
      throw new Error(appended.reason);
    }
    expect(fs.existsSync(appended.sessionFile)).toBe(true);
    expect(readSessionEntry(storePath, sessionKey)?.sessionFile).toBe(appended.sessionFile);
    expect(readSessionEntry(storePath, "agent:main:unrelated")?.sessionId).toBe(
      "unrelated-session",
    );
  });

  it("keeps delivery-proof checks on legacy folded-key fallback", async () => {
    const sessionsDir = await suiteRootTracker.make("legacy-alias-proof");
    const storePath = path.join(sessionsDir, "sessions.sqlite");
    const requestedKey = "agent:main:matrix:channel:!RoomABC:example.org";
    const foldedKey = "agent:main:matrix:channel:!roomabc:example.org";
    const foldedTranscript = path.join(sessionsDir, "folded-session.jsonl");
    fs.writeFileSync(
      foldedTranscript,
      `${JSON.stringify({
        id: "wrong-room-message",
        message: { role: "user", content: "wrong room", timestamp: 1 },
        type: "message",
      })}\n`,
      "utf8",
    );
    await saveSessionStore(
      storePath,
      {
        [foldedKey]: {
          lastTo: "!Different:example.org",
          sessionFile: foldedTranscript,
          sessionId: "folded-session",
          updatedAt: 10,
        },
      },
      { skipMaintenance: true },
    );
    resetSessionStoreSqliteStatsForTest();

    await expect(
      readRecentUserAssistantTextForSession({ sessionKey: requestedKey, storePath }),
    ).resolves.toEqual([]);
    expect(getSessionStoreSqliteStatsForTest()).toMatchObject({
      selectAll: 1,
      selectByKey: 1,
    });
  });

  it("rejects an exact opaque-key row with mismatched delivery proof", async () => {
    const sessionsDir = await suiteRootTracker.make("exact-key-proof");
    const storePath = path.join(sessionsDir, "sessions.sqlite");
    const sessionKey = "agent:main:matrix:channel:!RoomABC:example.org";
    const transcript = path.join(sessionsDir, "wrong-target.jsonl");
    fs.writeFileSync(
      transcript,
      `${JSON.stringify({
        id: "wrong-target-message",
        message: { role: "user", content: "wrong target", timestamp: 1 },
        type: "message",
      })}\n`,
      "utf8",
    );
    await saveSessionStore(
      storePath,
      {
        [sessionKey]: {
          lastTo: "!Different:example.org",
          sessionFile: transcript,
          sessionId: "wrong-target",
          updatedAt: 10,
        },
      },
      { skipMaintenance: true },
    );
    resetSessionStoreSqliteStatsForTest();

    await expect(readRecentUserAssistantTextForSession({ sessionKey, storePath })).resolves.toEqual(
      [],
    );
    expect(getSessionStoreSqliteStatsForTest()).toMatchObject({
      selectAll: 1,
      selectByKey: 1,
    });
  });
});
