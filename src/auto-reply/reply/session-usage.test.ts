import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  flushSessionStoreBackfillForTest,
  loadSessionStore,
  type SessionEntry,
} from "../../config/sessions.js";
import { persistSessionContinuityUpdate } from "./session-usage.js";

describe("persistSessionContinuityUpdate", () => {
  let tmpDir: string;
  let storePath: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-session-usage-"));
    storePath = path.join(tmpDir, "sessions.json");
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("clears persisted cli session continuity when requested", async () => {
    const sessionKey = "agent:main:main";
    const sessionStore: Record<string, SessionEntry> = {
      [sessionKey]: {
        sessionId: "openclaw-session",
        updatedAt: 1,
        modelProvider: "claude-cli-streaming",
        cliSessionIds: { "claude-cli-streaming": "old-stream-session" },
        cliSessionBindings: {
          "claude-cli-streaming": {
            sessionId: "old-stream-session",
          },
        },
      },
    };
    await fs.writeFile(storePath, JSON.stringify(sessionStore, null, 2));

    await persistSessionContinuityUpdate({
      storePath,
      sessionKey,
      providerUsed: "claude-cli-streaming",
      modelUsed: "claude-opus-4-7",
      clearCliSession: true,
    });

    await flushSessionStoreBackfillForTest(storePath);
    const stored = loadSessionStore(storePath);
    expect(stored[sessionKey]?.model).toBe("claude-opus-4-7");
    expect(stored[sessionKey]?.cliSessionBindings).toBeUndefined();
    expect(stored[sessionKey]?.cliSessionIds).toBeUndefined();
  });
});
