import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  flushSessionStoreBackfillForTest,
  loadSessionStore,
  resetSessionStoreBackfillRuntimeForTest,
  saveSessionStore,
  updateLastRoute,
} from "../sessions.js";
import type { SessionEntry } from "./types.js";

function createEntry(overrides: Partial<SessionEntry> = {}): SessionEntry {
  return {
    sessionId: "sess-1",
    updatedAt: 1,
    chatType: "direct",
    ...overrides,
  };
}

describe("session store sqlite hot path", () => {
  afterEach(() => {
    resetSessionStoreBackfillRuntimeForTest();
  });

  it("loads entries from the single sqlite store", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-session-sqlite-load-"));
    const storePath = path.join(dir, "sessions.sqlite");
    const sessionKey = "agent:main:main";
    await saveSessionStore(
      storePath,
      {
        [sessionKey]: createEntry({
          lastChannel: "signal",
          lastTo: "+15551234567",
          skillsSnapshot: {
            prompt: "skills",
            skills: [],
          },
          systemPromptReport: {
            source: "run",
            generatedAt: 1,
            systemPrompt: {
              chars: 1,
              projectContextChars: 0,
              nonProjectContextChars: 1,
            },
            injectedWorkspaceFiles: [],
            skills: { promptChars: 0, entries: [] },
            tools: { listChars: 0, schemaChars: 0, entries: [] },
          },
        }),
      },
      { skipMaintenance: true },
    );

    const loaded = loadSessionStore(storePath, { skipCache: true });
    expect(loaded[sessionKey]?.lastChannel).toBe("signal");
    expect(loaded[sessionKey]?.lastTo).toBe("+15551234567");
    expect(loaded[sessionKey]?.skillsSnapshot).toEqual({
      prompt: "",
      skills: [],
    });
    expect(loaded[sessionKey]?.systemPromptReport).toMatchObject({
      source: "run",
      generatedAt: 1,
    });
  });

  it("writes route updates directly to sqlite without cold backfill", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-session-sqlite-route-"));
    const storePath = path.join(dir, "sessions.sqlite");
    const sessionKey = "agent:main:main";
    await saveSessionStore(
      storePath,
      {
        [sessionKey]: createEntry({
          lastChannel: "telegram",
          lastTo: "old",
        }),
      },
      { skipMaintenance: true },
    );

    await updateLastRoute({
      storePath,
      sessionKey,
      deliveryContext: {
        channel: "signal",
        to: "+15551234567",
      },
    });

    const storeBeforeFlush = loadSessionStore(storePath, { skipCache: true });
    expect(storeBeforeFlush[sessionKey]?.lastChannel).toBe("signal");
    expect(storeBeforeFlush[sessionKey]?.lastTo).toBe("+15551234567");

    await flushSessionStoreBackfillForTest(storePath);

    const storeAfterFlush = loadSessionStore(storePath, { skipCache: true });
    expect(storeAfterFlush[sessionKey]?.lastChannel).toBe("signal");
    expect(storeAfterFlush[sessionKey]?.lastTo).toBe("+15551234567");
  });

  it("keeps unchanged route updates as a sqlite no-op", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-session-sqlite-noop-"));
    const storePath = path.join(dir, "sessions.sqlite");
    const sessionKey = "agent:main:main";
    await saveSessionStore(
      storePath,
      {
        [sessionKey]: createEntry({
          updatedAt: 99,
          lastChannel: "signal",
          lastTo: "+15551234567",
          deliveryContext: {
            channel: "signal",
            to: "+15551234567",
          },
        }),
      },
      { skipMaintenance: true },
    );

    await updateLastRoute({
      storePath,
      sessionKey,
      deliveryContext: {
        channel: "signal",
        to: "+15551234567",
      },
    });

    await flushSessionStoreBackfillForTest(storePath);
    const storeAfterFlush = loadSessionStore(storePath, { skipCache: true });
    expect(storeAfterFlush[sessionKey]?.updatedAt).toBe(99);
    expect(storeAfterFlush[sessionKey]?.lastChannel).toBe("signal");
    expect(storeAfterFlush[sessionKey]?.lastTo).toBe("+15551234567");
  });
});
