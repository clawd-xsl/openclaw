// Verifies that reply dispatch resolves known SQLite sessions with point reads.
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
import { resolveDispatchSessionStoreLookup } from "./dispatch-session-store-lookup.js";
import { buildTestCtx } from "./test-ctx.js";

const cleanupDirs: string[] = [];

afterEach(() => {
  closeSessionStoreSqliteDatabasesForTest();
  clearSessionStoreCaches();
  for (const dir of cleanupDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("dispatch session-store SQLite hot path", () => {
  it("point-reads the command target without selecting unrelated sessions", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-dispatch-session-sqlite-"));
    cleanupDirs.push(dir);
    const storePath = path.join(dir, "sessions.sqlite");
    const sourceSessionKey = "agent:main:discord:channel:source";
    const targetSessionKey = "agent:main:explicit:target";
    await saveSessionStore(
      storePath,
      {
        [sourceSessionKey]: {
          sessionId: "source-session",
          updatedAt: 1,
        },
        [targetSessionKey]: {
          sessionId: "target-session",
          updatedAt: 2,
        },
      },
      { skipMaintenance: true },
    );

    closeSessionStoreSqliteDatabasesForTest();
    clearSessionStoreCaches();
    resetSessionStoreSqliteStatsForTest();

    const resolved = resolveDispatchSessionStoreLookup(
      buildTestCtx({
        SessionKey: sourceSessionKey,
        CommandSource: "native",
        CommandAuthorized: true,
        CommandTargetSessionKey: targetSessionKey,
      }),
      { session: { store: storePath } } satisfies OpenClawConfig,
    );

    expect(resolved.sessionKey).toBe(targetSessionKey);
    expect(resolved.entry?.sessionId).toBe("target-session");
    expect(getSessionStoreSqliteStatsForTest()).toMatchObject({
      selectAll: 0,
      selectByKey: 1,
    });
  });
});
