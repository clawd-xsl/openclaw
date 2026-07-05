import type {
  PluginStateEntry,
  PluginStateKeyedStore,
} from "openclaw/plugin-sdk/plugin-state-runtime";
import { describe, expect, it } from "vitest";
import {
  createSessionMemoryFlushCandidate,
  createSessionMemoryFlushPlanSnapshot,
  createSessionMemoryFlushWorkspaceTarget,
  isSessionMemoryFlushRecord,
  SESSION_MEMORY_FLUSH_PLAN_TEXT_MAX_BYTES,
  SESSION_MEMORY_FLUSH_PROCESSING_LEASE_MS,
  SESSION_MEMORY_FLUSH_RECORD_MAX_BYTES,
  SessionMemoryFlushRepository,
  type SessionMemoryFlushRecord,
} from "./session-memory-flush-store.js";

function createMemoryStore<T>(): PluginStateKeyedStore<T> {
  const values = new Map<string, PluginStateEntry<T>>();
  return {
    async register(key, value) {
      values.set(key, { key, value, createdAt: Date.now() });
    },
    async registerIfAbsent(key, value) {
      if (values.has(key)) {
        return false;
      }
      values.set(key, { key, value, createdAt: Date.now() });
      return true;
    },
    async update(key, updater) {
      const current = values.get(key);
      const next = updater(current?.value);
      if (next === undefined) {
        return false;
      }
      values.set(key, { key, value: next, createdAt: current?.createdAt ?? Date.now() });
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

function createInput(messageCount = 2) {
  return {
    agentId: "main",
    sessionId: "ended-session",
    sessionKey: "agent:main:main",
    endedAt: Date.UTC(2026, 6, 5),
    messageCount,
    maxPromptTokens: 16_000,
    generationConfigFingerprint: "prompt=16000",
    workspaceTarget: createSessionMemoryFlushWorkspaceTarget({
      configuredPath: "/workspace/main",
      realPath: "/workspace/main",
      device: "1",
      inode: "2",
    }),
    plan: createSessionMemoryFlushPlanSnapshot({
      prompt: "extract",
      systemPrompt: "system",
      relativePath: "memory/2026-07-05.md",
    }),
  };
}

describe("SessionMemoryFlushRepository", () => {
  it("uses a long lease and fences pre-candidate transcript growth", async () => {
    expect(SESSION_MEMORY_FLUSH_PROCESSING_LEASE_MS).toBeGreaterThanOrEqual(30 * 60 * 1_000);
    let now = 1_000;
    const repository = new SessionMemoryFlushRepository({
      now: () => now,
      openStore: () => createMemoryStore<SessionMemoryFlushRecord>(),
    });
    const enqueued = await repository.enqueue(createInput());
    const firstClaim = await repository.claim(enqueued.key);
    expect(firstClaim?.leaseExpiresAt).toBe(now + SESSION_MEMORY_FLUSH_PROCESSING_LEASE_MS);
    now += 1;
    const grown = await repository.enqueue(createInput(3));
    expect(grown.record.status).toBe("pending");
    expect(grown.record.revision).toBeGreaterThan(firstClaim?.revision ?? 0);
    expect(
      await repository.persistCandidate(enqueued.key, {
        candidate: createSessionMemoryFlushCandidate({ kind: "noop" }),
        expectedRevision: firstClaim?.revision ?? -1,
        extractedMessageCount: 2,
        transcriptFingerprint: "a".repeat(64),
      }),
    ).toBeUndefined();
  });

  it("never reopens a completed operation after content or plan changes", async () => {
    const store = createMemoryStore<SessionMemoryFlushRecord>();
    const repository = new SessionMemoryFlushRepository({ openStore: () => store });
    const enqueued = await repository.enqueue(createInput());
    const claim = await repository.claim(enqueued.key);
    if (!claim) {
      throw new Error("expected claim");
    }
    await repository.persistCandidate(enqueued.key, {
      candidate: createSessionMemoryFlushCandidate({ kind: "append", content: "durable" }),
      expectedRevision: claim.revision,
      extractedMessageCount: 2,
      transcriptFingerprint: "b".repeat(64),
    });
    const completed = await repository.markComplete(enqueued.key, {
      expectedRevision: claim.revision,
      projectedAt: Date.now(),
    });
    const changed = createInput(99);
    changed.plan = createSessionMemoryFlushPlanSnapshot({
      prompt: "new prompt",
      systemPrompt: "new system",
      relativePath: "memory/2026-07-06.md",
    });
    const duplicate = await repository.enqueue(changed);
    expect(duplicate.shouldProcess).toBe(false);
    expect(duplicate.record).toEqual(completed);
    expect(duplicate.record.plan.relativePath).toBe("memory/2026-07-05.md");
  });

  it("bounds oversized plan text so a maximal persisted candidate stays below 64 KiB", async () => {
    const plan = createSessionMemoryFlushPlanSnapshot({
      prompt: `prompt-${"\\\u0001".repeat(50_000)}`,
      systemPrompt: `system-${"\\\n".repeat(50_000)}`,
      relativePath: "memory/2026-07-05.md",
    });
    expect(Buffer.byteLength(JSON.stringify(plan.prompt), "utf8")).toBeLessThanOrEqual(
      SESSION_MEMORY_FLUSH_PLAN_TEXT_MAX_BYTES,
    );
    expect(Buffer.byteLength(JSON.stringify(plan.systemPrompt), "utf8")).toBeLessThanOrEqual(
      SESSION_MEMORY_FLUSH_PLAN_TEXT_MAX_BYTES,
    );
    const repository = new SessionMemoryFlushRepository({
      openStore: () => createMemoryStore<SessionMemoryFlushRecord>(),
    });
    const enqueued = await repository.enqueue({ ...createInput(), plan });
    const claim = await repository.claim(enqueued.key);
    if (!claim) {
      throw new Error("expected claim");
    }
    await repository.persistCandidate(enqueued.key, {
      candidate: createSessionMemoryFlushCandidate({
        kind: "append",
        content: "\\\n".repeat(5_000),
      }),
      expectedRevision: claim.revision,
      extractedMessageCount: 2,
      transcriptFingerprint: "c".repeat(64),
    });
    const record = await repository.lookup("main", "ended-session");
    expect(record).toBeDefined();
    expect(Buffer.byteLength(JSON.stringify(record), "utf8")).toBeLessThan(
      SESSION_MEMORY_FLUSH_RECORD_MAX_BYTES,
    );
  });

  it("rejects records with forged operation, candidate, or plan hashes", async () => {
    const store = createMemoryStore<SessionMemoryFlushRecord>();
    const repository = new SessionMemoryFlushRepository({ openStore: () => store });
    const enqueued = await repository.enqueue(createInput());
    const claim = await repository.claim(enqueued.key);
    if (!claim) {
      throw new Error("expected claim");
    }
    const persisted = await repository.persistCandidate(enqueued.key, {
      candidate: createSessionMemoryFlushCandidate({ kind: "append", content: "durable" }),
      expectedRevision: claim.revision,
      extractedMessageCount: 2,
      transcriptFingerprint: "d".repeat(64),
    });
    expect(isSessionMemoryFlushRecord(persisted)).toBe(true);
    expect(isSessionMemoryFlushRecord({ ...persisted, operationId: `v1:${"0".repeat(64)}` })).toBe(
      false,
    );
    expect(
      isSessionMemoryFlushRecord({
        ...persisted,
        candidate: { ...persisted?.candidate, sha256: "0".repeat(64) },
      }),
    ).toBe(false);
    expect(
      isSessionMemoryFlushRecord({
        ...persisted,
        plan: { ...persisted?.plan, fingerprint: "0".repeat(64) },
      }),
    ).toBe(false);
    expect(
      isSessionMemoryFlushRecord({
        ...persisted,
        workspaceTarget: { ...persisted?.workspaceTarget, fingerprint: "0".repeat(64) },
      }),
    ).toBe(false);
    if (!persisted) {
      throw new Error("expected persisted record");
    }
    await store.register(enqueued.key, {
      ...persisted,
      operationId: `v1:${"0".repeat(64)}`,
    });
    await expect(repository.enqueue(createInput())).rejects.toThrow("integrity validation");
  });

  it("rejects a forged workspace target before registering the outbox record", async () => {
    const repository = new SessionMemoryFlushRepository({
      openStore: () => createMemoryStore<SessionMemoryFlushRecord>(),
    });
    const input = createInput();
    input.workspaceTarget = { ...input.workspaceTarget, fingerprint: "0".repeat(64) };
    await expect(repository.enqueue(input)).rejects.toThrow("integrity validation");
    await expect(repository.lookup("main", "ended-session")).resolves.toBeUndefined();
  });

  it("does not revive a durable cancellation tombstone on duplicate enqueue", async () => {
    const repository = new SessionMemoryFlushRepository({
      openStore: () => createMemoryStore<SessionMemoryFlushRecord>(),
    });
    const first = await repository.enqueue(createInput());
    await repository.claim(first.key);
    await repository.cancel(first.key);

    const duplicate = await repository.enqueue(createInput(5));

    expect(duplicate.shouldProcess).toBe(false);
    expect(duplicate.record).toMatchObject({
      status: "failed",
      terminalCode: "cancelled",
      nextAttemptAt: null,
    });
  });

  it("requires the projection lock when a failed record retains an append candidate", async () => {
    const repository = new SessionMemoryFlushRepository({
      openStore: () => createMemoryStore<SessionMemoryFlushRecord>(),
    });
    const enqueued = await repository.enqueue(createInput());
    const claim = await repository.claim(enqueued.key);
    if (!claim) {
      throw new Error("expected claim");
    }
    await repository.persistCandidate(enqueued.key, {
      candidate: createSessionMemoryFlushCandidate({ kind: "append", content: "durable" }),
      expectedRevision: claim.revision,
      extractedMessageCount: 2,
      transcriptFingerprint: "e".repeat(64),
    });
    await repository.markFailed(enqueued.key, {
      error: "projection lock timed out",
      expectedRevision: claim.revision,
    });

    await expect(repository.cancel(enqueued.key)).resolves.toMatchObject({
      requiresProjectionLock: true,
      record: { terminalCode: "cancelled" },
    });
  });

  it("rejects non-canonical or impossible projection dates", () => {
    expect(() =>
      createSessionMemoryFlushPlanSnapshot({
        prompt: "prompt",
        systemPrompt: "system",
        relativePath: "MEMORY.md",
      }),
    ).toThrow("canonical");
    expect(() =>
      createSessionMemoryFlushPlanSnapshot({
        prompt: "prompt",
        systemPrompt: "system",
        relativePath: "memory/2026-02-31.md",
      }),
    ).toThrow("canonical");
  });
});
