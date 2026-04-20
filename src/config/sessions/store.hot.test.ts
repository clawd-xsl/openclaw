import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  flushSessionStoreBackfillForTest,
  loadSessionStore,
  resetSessionStoreBackfillRuntimeForTest,
  updateLastRoute,
} from "../sessions.js";
import { resolveHotSessionStorePath } from "./store-hot.js";
import type { SessionEntry } from "./types.js";

function createEntry(overrides: Partial<SessionEntry> = {}): SessionEntry {
  return {
    sessionId: "sess-1",
    updatedAt: 1,
    chatType: "direct",
    ...overrides,
  };
}

describe("session store hot overlay", () => {
  afterEach(() => {
    resetSessionStoreBackfillRuntimeForTest();
  });

  it("overlays hot entries while preserving cold-only fields", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-session-hot-overlay-"));
    const storePath = path.join(dir, "sessions.json");
    const hotPath = resolveHotSessionStorePath(storePath);
    const sessionKey = "agent:main:main";
    await fs.writeFile(
      storePath,
      JSON.stringify(
        {
          [sessionKey]: createEntry({
            lastChannel: "telegram",
            lastTo: "old",
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
        null,
        2,
      ),
    );
    await fs.writeFile(
      hotPath,
      JSON.stringify(
        {
          [sessionKey]: createEntry({
            updatedAt: 2,
            lastChannel: "signal",
            lastTo: "+15551234567",
          }),
        },
        null,
        2,
      ),
    );

    const loaded = loadSessionStore(storePath, { skipCache: true });
    expect(loaded[sessionKey]?.lastChannel).toBe("signal");
    expect(loaded[sessionKey]?.lastTo).toBe("+15551234567");
    expect(loaded[sessionKey]?.skillsSnapshot).toEqual({
      prompt: "skills",
      skills: [],
    });
    expect(loaded[sessionKey]?.systemPromptReport).toMatchObject({
      source: "run",
      generatedAt: 1,
    });
  });

  it("writes route updates to the hot store before cold backfill flushes", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-session-hot-route-"));
    const storePath = path.join(dir, "sessions.json");
    const hotPath = resolveHotSessionStorePath(storePath);
    const sessionKey = "agent:main:main";
    await fs.writeFile(
      storePath,
      JSON.stringify(
        {
          [sessionKey]: createEntry({
            lastChannel: "telegram",
            lastTo: "old",
          }),
        },
        null,
        2,
      ),
    );

    await updateLastRoute({
      storePath,
      sessionKey,
      deliveryContext: {
        channel: "signal",
        to: "+15551234567",
      },
    });

    const hotStore = JSON.parse(await fs.readFile(hotPath, "utf-8")) as Record<
      string,
      SessionEntry
    >;
    const coldStoreBeforeFlush = JSON.parse(await fs.readFile(storePath, "utf-8")) as Record<
      string,
      SessionEntry
    >;
    expect(hotStore[sessionKey]?.lastChannel).toBe("signal");
    expect(hotStore[sessionKey]?.lastTo).toBe("+15551234567");
    expect(coldStoreBeforeFlush[sessionKey]?.lastChannel).toBe("telegram");
    expect(coldStoreBeforeFlush[sessionKey]?.lastTo).toBe("old");

    await flushSessionStoreBackfillForTest(storePath);

    const coldStoreAfterFlush = JSON.parse(await fs.readFile(storePath, "utf-8")) as Record<
      string,
      SessionEntry
    >;
    expect(coldStoreAfterFlush[sessionKey]?.lastChannel).toBe("signal");
    expect(coldStoreAfterFlush[sessionKey]?.lastTo).toBe("+15551234567");
  });

  it("skips hot-store writes when a route update is unchanged", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-session-hot-noop-"));
    const storePath = path.join(dir, "sessions.json");
    const hotPath = resolveHotSessionStorePath(storePath);
    const sessionKey = "agent:main:main";
    await fs.writeFile(
      storePath,
      JSON.stringify(
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
        null,
        2,
      ),
    );
    await fs.writeFile(
      hotPath,
      JSON.stringify(
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
        null,
        2,
      ),
    );

    const beforeHotStat = await fs.stat(hotPath);
    await new Promise((resolve) => setTimeout(resolve, 20));

    await updateLastRoute({
      storePath,
      sessionKey,
      deliveryContext: {
        channel: "signal",
        to: "+15551234567",
      },
    });

    const afterHotStat = await fs.stat(hotPath);
    expect(afterHotStat.mtimeMs).toBe(beforeHotStat.mtimeMs);

    await flushSessionStoreBackfillForTest(storePath);
    const coldStoreAfterFlush = JSON.parse(await fs.readFile(storePath, "utf-8")) as Record<
      string,
      SessionEntry
    >;
    expect(coldStoreAfterFlush[sessionKey]?.updatedAt).toBe(99);
    expect(coldStoreAfterFlush[sessionKey]?.lastChannel).toBe("signal");
    expect(coldStoreAfterFlush[sessionKey]?.lastTo).toBe("+15551234567");
  });
});
