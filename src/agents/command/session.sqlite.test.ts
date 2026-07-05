// Verifies that the normal agent-command session resolver keeps SQLite reads keyed.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { clearSessionStoreCaches } from "../../config/sessions/store-cache.js";
import {
  closeSessionStoreSqliteDatabasesForTest,
  getSessionStoreSqliteStatsForTest,
  resetSessionStoreSqliteStatsForTest,
} from "../../config/sessions/store-sqlite.js";
import { saveSessionStore } from "../../config/sessions/store.js";
import { resolveSession } from "./session.js";

const cleanupDirs: string[] = [];

afterEach(() => {
  closeSessionStoreSqliteDatabasesForTest();
  clearSessionStoreCaches();
  for (const dir of cleanupDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("resolveSession SQLite hot path", () => {
  it("point-reads a known agent-command session without selecting the store", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-agent-session-sqlite-"));
    cleanupDirs.push(dir);
    const storePath = path.join(dir, "sessions.sqlite");
    const sessionKey = "agent:main:explicit:known";
    await saveSessionStore(
      storePath,
      {
        [sessionKey]: {
          sessionId: "known-session",
          updatedAt: Date.now(),
        },
        "agent:main:explicit:unrelated": {
          sessionId: "unrelated-session",
          updatedAt: Date.now(),
        },
      },
      { skipMaintenance: true },
    );

    closeSessionStoreSqliteDatabasesForTest();
    clearSessionStoreCaches();
    resetSessionStoreSqliteStatsForTest();

    const resolved = resolveSession({
      cfg: { session: { store: storePath } } satisfies OpenClawConfig,
      sessionKey,
      agentId: "main",
      clone: false,
    });

    expect(resolved.sessionId).toBe("known-session");
    expect(resolved.sessionEntry?.sessionId).toBe("known-session");
    expect(Object.keys(resolved.sessionStore ?? {})).toEqual([sessionKey]);
    expect(getSessionStoreSqliteStatsForTest()).toMatchObject({
      selectAll: 0,
      selectByKey: 1,
    });
  });

  it("keeps a missing first-turn session key on the point-read path", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-agent-session-new-sqlite-"));
    cleanupDirs.push(dir);
    const storePath = path.join(dir, "sessions.sqlite");

    resetSessionStoreSqliteStatsForTest();
    const resolved = resolveSession({
      cfg: { session: { store: storePath } } satisfies OpenClawConfig,
      sessionKey: "agent:main:explicit:new",
      agentId: "main",
      clone: false,
    });

    expect(resolved.isNewSession).toBe(true);
    expect(getSessionStoreSqliteStatsForTest()).toMatchObject({
      selectAll: 0,
      selectByKey: 1,
    });
  });
});
