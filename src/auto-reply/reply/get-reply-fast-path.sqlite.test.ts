// Verifies that fast reply bootstrap keeps SQLite session reads row-scoped.
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
import { initFastReplySessionState } from "./get-reply-fast-path.js";
import { buildGetReplyCtx } from "./get-reply.test-fixtures.js";

const cleanupDirs: string[] = [];

afterEach(() => {
  closeSessionStoreSqliteDatabasesForTest();
  clearSessionStoreCaches();
  for (const dir of cleanupDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("fast reply SQLite session bootstrap", () => {
  it("point-reads the active session without selecting unrelated rows", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-fast-reply-sqlite-"));
    cleanupDirs.push(dir);
    const storePath = path.join(dir, "sessions.sqlite");
    const sessionKey = "agent:main:telegram:direct:target";
    await saveSessionStore(
      storePath,
      {
        [sessionKey]: {
          sessionId: "target-session",
          updatedAt: 2,
        },
        "agent:main:telegram:direct:unrelated": {
          sessionId: "unrelated-session",
          updatedAt: 1,
        },
      },
      { skipMaintenance: true },
    );

    closeSessionStoreSqliteDatabasesForTest();
    clearSessionStoreCaches();
    resetSessionStoreSqliteStatsForTest();

    const result = initFastReplySessionState({
      ctx: buildGetReplyCtx({ SessionKey: sessionKey }),
      cfg: { session: { store: storePath } } satisfies OpenClawConfig,
      agentId: "main",
      commandAuthorized: true,
      workspaceDir: dir,
    });

    expect(result.sessionId).toBe("target-session");
    expect(result.sessionStore).toEqual({
      [sessionKey]: expect.objectContaining({ sessionId: "target-session" }),
    });
    expect(getSessionStoreSqliteStatsForTest()).toMatchObject({
      selectAll: 0,
      selectByKey: 1,
    });
  });
});
