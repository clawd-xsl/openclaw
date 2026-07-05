import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  clearSessionStoreCacheForTest,
  resolveMainSessionKey,
  saveSessionStore,
} from "../config/sessions.js";
import { loadSessionEntry } from "../config/sessions/session-accessor.js";
import {
  closeSessionStoreSqliteDatabasesForTest,
  getSessionStoreSqliteStatsForTest,
  resetSessionStoreSqliteStatsForTest,
  upsertSessionEntryInSqlite,
} from "../config/sessions/store-sqlite.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createSuiteTempRootTracker } from "../test-helpers/temp-dir.js";
import { runHeartbeatOnce } from "./heartbeat-runner.js";
import { installHeartbeatRunnerTestRuntime } from "./heartbeat-runner.test-harness.js";
import { setHeartbeatsEnabled } from "./heartbeat-wake.js";
import { enqueueSystemEvent, resetSystemEventsForTest } from "./system-events.js";

const suiteRootTracker = createSuiteTempRootTracker({ prefix: "openclaw-heartbeat-sqlite-" });

installHeartbeatRunnerTestRuntime();

beforeAll(async () => {
  await suiteRootTracker.setup();
});

afterEach(() => {
  resetSystemEventsForTest();
  clearSessionStoreCacheForTest();
  resetSessionStoreSqliteStatsForTest();
  closeSessionStoreSqliteDatabasesForTest();
  setHeartbeatsEnabled(true);
});

afterAll(async () => {
  closeSessionStoreSqliteDatabasesForTest();
  await suiteRootTracker.cleanup();
});

describe("heartbeat SQLite session access", () => {
  it("keeps known-key preflight and timestamp restoration off full-store scans", async () => {
    const dir = await suiteRootTracker.make("point-access");
    const storePath = path.join(dir, "sessions.sqlite");
    const cfg: OpenClawConfig = {
      agents: { defaults: { heartbeat: { every: "5m" } } },
      session: { store: storePath },
    };
    const sessionKey = resolveMainSessionKey(cfg);
    await saveSessionStore(
      storePath,
      {
        [sessionKey]: { sessionId: "heartbeat-session", updatedAt: 10 },
        "agent:main:unrelated": { sessionId: "unrelated", updatedAt: 20 },
      },
      { skipMaintenance: true },
    );
    enqueueSystemEvent("Exec completed (run-sqlite, code 0)", { sessionKey });
    resetSessionStoreSqliteStatsForTest();

    const result = await runHeartbeatOnce({
      cfg,
      source: "exec-event",
      deps: {
        getQueueSize: () => 0,
        getReplyFromConfig: vi.fn(async () => {
          upsertSessionEntryInSqlite({
            storePath,
            sessionKey,
            entry: { sessionId: "heartbeat-session", updatedAt: 5 },
          });
          return undefined;
        }),
        nowMs: () => 100,
      },
    });

    expect(result.status).toBe("ran");
    expect(getSessionStoreSqliteStatsForTest()).toMatchObject({
      selectAll: 0,
      selectByKey: 3,
      upsert: 2,
    });
    expect(loadSessionEntry({ storePath, sessionKey })?.updatedAt).toBeGreaterThanOrEqual(10);
  });
});
