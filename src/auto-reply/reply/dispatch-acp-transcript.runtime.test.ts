// ACP transcript dispatch tests guard keyed SQLite session lookup.
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  getSessionStoreSqliteStatsForTest,
  resetSessionStoreSqliteStatsForTest,
} from "../../config/sessions/store-sqlite.js";
import { clearSessionStoreCacheForTest, saveSessionStore } from "../../config/sessions/store.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createSuiteTempRootTracker } from "../../test-helpers/temp-dir.js";

const transcriptMocks = vi.hoisted(() => ({
  persistAcpTurnTranscript: vi.fn(async () => undefined),
}));

vi.mock("../../agents/command/attempt-execution.js", () => ({
  persistAcpTurnTranscript: transcriptMocks.persistAcpTurnTranscript,
}));

import { persistAcpDispatchTranscript } from "./dispatch-acp-transcript.runtime.js";

const suiteRootTracker = createSuiteTempRootTracker({ prefix: "openclaw-acp-transcript-sqlite-" });

beforeAll(async () => {
  await suiteRootTracker.setup();
});

afterEach(() => {
  transcriptMocks.persistAcpTurnTranscript.mockClear();
  clearSessionStoreCacheForTest();
  resetSessionStoreSqliteStatsForTest();
});

afterAll(async () => {
  clearSessionStoreCacheForTest();
  await suiteRootTracker.cleanup();
});

describe("persistAcpDispatchTranscript", () => {
  it("passes a keyed SQLite session view to transcript persistence", async () => {
    const dir = await suiteRootTracker.make("known-session");
    const storePath = path.join(dir, "sessions.sqlite");
    const sessionKey = "agent:main:main";
    await saveSessionStore(
      storePath,
      {
        [sessionKey]: { sessionId: "acp-session", updatedAt: 10 },
        "agent:main:unrelated": { sessionId: "unrelated", updatedAt: 20 },
      },
      { skipMaintenance: true },
    );
    resetSessionStoreSqliteStatsForTest();

    await persistAcpDispatchTranscript({
      cfg: { session: { store: storePath } } satisfies OpenClawConfig,
      finalText: "done",
      promptText: "work",
      sessionKey,
    });

    expect(getSessionStoreSqliteStatsForTest()).toMatchObject({
      selectAll: 0,
      selectByKey: 1,
    });
    expect(transcriptMocks.persistAcpTurnTranscript).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionEntry: expect.objectContaining({ sessionId: "acp-session" }),
        sessionId: "acp-session",
        sessionKey,
        sessionStore: {
          [sessionKey]: expect.objectContaining({ sessionId: "acp-session" }),
        },
        storePath,
      }),
    );
  });
});
