import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { resetConfigRuntimeState, setRuntimeConfigSnapshot } from "../config/config.js";
import {
  clearSessionStoreCacheForTest,
  saveSessionStore,
  type SessionEntry,
} from "../config/sessions.js";
import {
  getSessionStoreSqliteStatsForTest,
  resetSessionStoreSqliteStatsForTest,
} from "../config/sessions/store-sqlite.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { withStateDirEnv } from "../test-helpers/state-dir-env.js";
import { loadSessionEntry } from "./session-utils.js";

afterEach(() => {
  resetConfigRuntimeState();
  clearSessionStoreCacheForTest();
  resetSessionStoreSqliteStatsForTest();
});

async function withSqliteGatewayStore(
  prefix: string,
  config: Omit<OpenClawConfig, "session"> & { session?: OpenClawConfig["session"] },
  run: (storePath: string) => Promise<void>,
): Promise<void> {
  await withStateDirEnv(prefix, async ({ stateDir }) => {
    const storePath = path.join(stateDir, "sessions.sqlite");
    const cfg = {
      ...config,
      session: { ...config.session, store: storePath },
    } satisfies OpenClawConfig;
    setRuntimeConfigSnapshot(cfg, cfg);
    await run(storePath);
  });
}

describe("gateway SQLite session point lookup", () => {
  test("reads a known canonical key without enumerating the store", async () => {
    await withSqliteGatewayStore(
      "openclaw-gateway-session-point-",
      { agents: { list: [{ id: "main", default: true }] } },
      async (storePath) => {
        const sessionKey = "agent:main:main";
        await saveSessionStore(
          storePath,
          {
            [sessionKey]: { sessionId: "known", updatedAt: 10 },
            "agent:main:other": { sessionId: "unrelated", updatedAt: 20 },
          },
          { skipMaintenance: true },
        );
        resetSessionStoreSqliteStatsForTest();

        const loaded = loadSessionEntry(sessionKey);

        expect(loaded.entry?.sessionId).toBe("known");
        expect(Object.keys(loaded.store)).toEqual([sessionKey]);
        expect(getSessionStoreSqliteStatsForTest()).toEqual({
          selectAll: 0,
          selectByKey: 1,
          selectUpdatedAt: 0,
          upsert: 0,
        });
      },
    );
  });

  test("queries only canonical and main-alias keys and chooses the freshest", async () => {
    await withSqliteGatewayStore(
      "openclaw-gateway-session-main-alias-",
      {
        session: { mainKey: "work" },
        agents: { list: [{ id: "ops", default: true }] },
      },
      async (storePath) => {
        await saveSessionStore(
          storePath,
          {
            "agent:ops:work": { sessionId: "canonical", updatedAt: 10 },
            "agent:ops:main": { sessionId: "legacy-main", updatedAt: 20 },
            "agent:ops:other": { sessionId: "unrelated", updatedAt: 30 },
          },
          { skipMaintenance: true },
        );
        resetSessionStoreSqliteStatsForTest();

        const loaded = loadSessionEntry("agent:ops:work");

        expect(loaded.entry?.sessionId).toBe("legacy-main");
        expect(loaded.legacyKey).toBe("agent:ops:main");
        expect(Object.keys(loaded.store).toSorted()).toEqual(["agent:ops:main", "agent:ops:work"]);
        expect(getSessionStoreSqliteStatsForTest()).toEqual({
          selectAll: 0,
          selectByKey: 2,
          selectUpdatedAt: 0,
          upsert: 0,
        });
      },
    );
  });

  test("keeps exact opaque keys ahead of fresher case-distinct rows", async () => {
    await withSqliteGatewayStore(
      "openclaw-gateway-session-opaque-exact-",
      { agents: { list: [{ id: "main", default: true }] } },
      async (storePath) => {
        const exactKey = "agent:main:matrix:channel:!AbC:example.org";
        const foldedKey = "agent:main:matrix:channel:!abc:example.org";
        const store: Record<string, SessionEntry> = {
          [exactKey]: { sessionId: "exact", updatedAt: 10 },
          [foldedKey]: {
            sessionId: "case-distinct",
            updatedAt: 20,
            deliveryContext: { channel: "matrix", to: "matrix:channel:!abc:example.org" },
          },
        };
        await saveSessionStore(storePath, store, { skipMaintenance: true });
        resetSessionStoreSqliteStatsForTest();

        const loaded = loadSessionEntry(exactKey);

        expect(loaded.entry?.sessionId).toBe("exact");
        expect(loaded.legacyKey).toBeUndefined();
        expect(getSessionStoreSqliteStatsForTest()).toEqual({
          selectAll: 0,
          selectByKey: 2,
          selectUpdatedAt: 0,
          upsert: 0,
        });
      },
    );
  });

  test("accepts a folded opaque key only with matching delivery proof", async () => {
    await withSqliteGatewayStore(
      "openclaw-gateway-session-opaque-alias-",
      { agents: { list: [{ id: "main", default: true }] } },
      async (storePath) => {
        const requestedKey = "agent:main:matrix:channel:!AbC:example.org";
        const foldedKey = "agent:main:matrix:channel:!abc:example.org";
        await saveSessionStore(
          storePath,
          {
            [foldedKey]: {
              sessionId: "legacy-folded",
              updatedAt: 10,
              deliveryContext: { channel: "matrix", to: "matrix:channel:!AbC:example.org" },
            },
          },
          { skipMaintenance: true },
        );
        resetSessionStoreSqliteStatsForTest();

        const loaded = loadSessionEntry(requestedKey);

        expect(loaded.entry?.sessionId).toBe("legacy-folded");
        expect(loaded.legacyKey).toBe(foldedKey);
        expect(getSessionStoreSqliteStatsForTest()).toEqual({
          selectAll: 0,
          selectByKey: 2,
          selectUpdatedAt: 0,
          upsert: 0,
        });
      },
    );
  });

  test("rejects a folded opaque key with case-distinct delivery proof", async () => {
    await withSqliteGatewayStore(
      "openclaw-gateway-session-opaque-reject-",
      { agents: { list: [{ id: "main", default: true }] } },
      async (storePath) => {
        const requestedKey = "agent:main:matrix:channel:!AbC:example.org";
        const foldedKey = "agent:main:matrix:channel:!abc:example.org";
        await saveSessionStore(
          storePath,
          {
            [foldedKey]: {
              sessionId: "different-room",
              updatedAt: 10,
              deliveryContext: { channel: "matrix", to: "matrix:channel:!abc:example.org" },
            },
          },
          { skipMaintenance: true },
        );
        resetSessionStoreSqliteStatsForTest();

        const loaded = loadSessionEntry(requestedKey);

        expect(loaded.entry).toBeUndefined();
        expect(getSessionStoreSqliteStatsForTest()).toEqual({
          selectAll: 0,
          selectByKey: 2,
          selectUpdatedAt: 0,
          upsert: 0,
        });
      },
    );
  });
});
