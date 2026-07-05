import type {
  PluginStateEntry,
  PluginStateKeyedStore,
} from "openclaw/plugin-sdk/plugin-state-runtime";
import { describe, expect, it } from "vitest";
import {
  buildSessionSummaryStoreKey,
  SESSION_SUMMARY_LEGACY_IMPORT_FINGERPRINT,
  SessionSummaryRepository,
  type SessionSummaryPredecessorIndexRecord,
  type SessionSummaryRecord,
} from "./session-summaries-store.js";

function createMemoryStore<T>(): PluginStateKeyedStore<T> {
  const values = new Map<string, PluginStateEntry<T>>();
  return {
    async register(key, value) {
      values.set(key, { key, value, createdAt: 1 });
    },
    async registerIfAbsent(key, value) {
      if (values.has(key)) {
        return false;
      }
      values.set(key, { key, value, createdAt: 1 });
      return true;
    },
    async update(key, updateValue) {
      const current = values.get(key);
      const next = updateValue(current?.value);
      if (next === undefined) {
        return false;
      }
      values.set(key, { key, value: next, createdAt: current?.createdAt ?? 1 });
      return true;
    },
    async lookup(key) {
      return values.get(key)?.value;
    },
    async consume(key) {
      const value = values.get(key)?.value;
      values.delete(key);
      return value;
    },
    async delete(key) {
      return values.delete(key);
    },
    async entries() {
      return [...values.values()];
    },
    async clear() {
      values.clear();
    },
  };
}

function createRepository(
  params: {
    store?: PluginStateKeyedStore<SessionSummaryRecord>;
    predecessorStore?: PluginStateKeyedStore<SessionSummaryPredecessorIndexRecord>;
  } = {},
) {
  const store = params.store ?? createMemoryStore<SessionSummaryRecord>();
  const predecessorStore =
    params.predecessorStore ?? createMemoryStore<SessionSummaryPredecessorIndexRecord>();
  return {
    repository: new SessionSummaryRepository({
      now: () => 5_000,
      openStore: () => store,
      openPredecessorIndexStore: () => predecessorStore,
    }),
    store,
    predecessorStore,
  };
}

function legacyInput() {
  return {
    agentId: "Main",
    sessionId: "old-session",
    sessionKey: "agent:main:main",
    nextSessionId: "new-session",
    endedAt: 2_000,
    messageCount: 8,
    summary: "Imported summary",
    model: "anthropic/claude-sonnet-4-6",
    generatedAt: 3_000,
  };
}

describe("SessionSummaryRepository legacy import", () => {
  it("persists a complete record and its deterministic predecessor index", async () => {
    const { repository } = createRepository();

    const result = await repository.importLegacyComplete(legacyInput());

    expect(result.status).toBe("inserted");
    expect(result.key).toBe(buildSessionSummaryStoreKey("main", "old-session"));
    expect(result.record).toMatchObject({
      agentId: "main",
      sessionId: "old-session",
      status: "complete",
      generationConfigFingerprint: SESSION_SUMMARY_LEGACY_IMPORT_FINGERPRINT,
      extractedMessageCount: 8,
      nextSessionId: "new-session",
      summary: "Imported summary",
    });
    await expect(
      repository.findDirectPredecessor({
        agentId: "main",
        currentSessionId: "new-session",
        lookbackDays: 365_000,
      }),
    ).resolves.toMatchObject({ sessionId: "old-session" });
  });

  it("never overwrites a current record at the deterministic key", async () => {
    const store = createMemoryStore<SessionSummaryRecord>();
    const { repository } = createRepository({ store });
    const current = {
      ...(await createRepository().repository.importLegacyComplete(legacyInput())).record!,
      generationConfigFingerprint: "current:v2",
      summary: "Current summary wins",
      nextSessionId: null,
    };
    await store.register(buildSessionSummaryStoreKey("main", "old-session"), current);

    const result = await repository.importLegacyComplete({
      ...legacyInput(),
      summary: "Legacy must not replace current",
    });

    expect(result.status).toBe("existing");
    expect(result.record?.summary).toBe("Current summary wins");
    expect(await store.lookup(result.key)).toEqual(current);
  });

  it("repairs a missing predecessor index on an idempotent rerun", async () => {
    const store = createMemoryStore<SessionSummaryRecord>();
    const { repository: seedRepository } = createRepository();
    const seeded = await seedRepository.importLegacyComplete(legacyInput());
    await store.register(seeded.key, seeded.record!);
    const { repository } = createRepository({ store });

    const result = await repository.importLegacyComplete(legacyInput());

    expect(result.status).toBe("existing");
    await expect(
      repository.findDirectPredecessor({
        agentId: "main",
        currentSessionId: "new-session",
        lookbackDays: 365_000,
      }),
    ).resolves.toMatchObject({ sessionId: "old-session" });
  });
});
