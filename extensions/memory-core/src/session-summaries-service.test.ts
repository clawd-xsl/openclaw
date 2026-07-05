import type {
  PluginStateEntry,
  PluginStateKeyedStore,
} from "openclaw/plugin-sdk/plugin-state-runtime";
import { describe, expect, it, vi } from "vitest";
import type { SessionSummariesConfig } from "./session-summaries-config.js";
import { SessionSummaryPolicyError, SessionSummaryService } from "./session-summaries-service.js";
import {
  SESSION_SUMMARY_PROCESSING_LEASE_MS,
  SESSION_SUMMARY_RETRY_BASE_MS,
  SessionSummaryRepository,
  type SessionSummaryPredecessorIndexRecord,
  type SessionSummaryRecord,
} from "./session-summaries-store.js";

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
    async update(key, updateValue) {
      const current = values.get(key);
      const next = updateValue(current?.value);
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

function createRepository(
  params: {
    now?: () => number;
    predecessorIndexStore?: PluginStateKeyedStore<SessionSummaryPredecessorIndexRecord>;
    store?: PluginStateKeyedStore<SessionSummaryRecord>;
  } = {},
) {
  const store = params.store ?? createMemoryStore<SessionSummaryRecord>();
  const predecessorIndexStore =
    params.predecessorIndexStore ?? createMemoryStore<SessionSummaryPredecessorIndexRecord>();
  return new SessionSummaryRepository({
    ...(params.now ? { now: params.now } : {}),
    openStore: () => store,
    openPredecessorIndexStore: () => predecessorIndexStore,
  });
}

const enabledConfig: SessionSummariesConfig = {
  enabled: true,
  autoInject: false,
  lookbackDays: 30,
  maxPromptTokens: 4_000,
  minMessages: 2,
};

function createCompletionResult(text = "Summary text") {
  return {
    text,
    provider: "openai",
    model: "gpt-5.4-mini",
    agentId: "main",
    usage: {},
    audit: { caller: { kind: "plugin" as const } },
  };
}

function createCompletion(text = "Summary text") {
  return vi.fn(async () => createCompletionResult(text));
}

function createDeferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  let reject: (error: unknown) => void = () => undefined;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function createAbortableCompletion() {
  const started = createDeferred<void>();
  const complete = vi.fn(
    async (params: { signal?: AbortSignal }) =>
      await new Promise<ReturnType<typeof createCompletionResult>>((resolve, reject) => {
        started.resolve();
        params.signal?.addEventListener(
          "abort",
          () =>
            reject(
              params.signal?.reason instanceof Error ? params.signal.reason : new Error("aborted"),
            ),
          { once: true },
        );
        void resolve;
      }),
  );
  return { complete, started: started.promise };
}

function createLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  };
}

function createTranscriptEvents() {
  return [
    { type: "message", message: { role: "user", content: "Plan the migration" } },
    { type: "message", message: { role: "assistant", content: "Use staged commits" } },
  ];
}

function createBoundedTranscriptResult() {
  return {
    available: true,
    events: createTranscriptEvents(),
    truncated: false,
  };
}

describe("SessionSummaryService", () => {
  it("durably claims once and keeps duplicate session_end events idempotent", async () => {
    const store = createMemoryStore<SessionSummaryRecord>();
    const repository = createRepository({ store });
    const complete = createCompletion();
    const readBoundedTranscriptEvents = vi.fn(async () => createBoundedTranscriptResult());
    const service = new SessionSummaryService({
      repository,
      complete,
      getConfig: () => enabledConfig,
      logger: createLogger(),
      readBoundedTranscriptEvents,
    });
    const event = {
      agentId: "main",
      sessionId: "session-old",
      sessionKey: "agent:main:main",
      nextSessionId: "session-new",
      endedAt: Date.now(),
      messageCount: 2,
    };

    await service.enqueue(event);
    await service.waitForIdle();
    await service.enqueue(event);
    await service.waitForIdle();

    expect(complete).toHaveBeenCalledTimes(1);
    expect(readBoundedTranscriptEvents).toHaveBeenCalledTimes(1);
    expect(readBoundedTranscriptEvents).toHaveBeenCalledWith({
      agentId: "main",
      sessionId: "session-old",
      sessionKey: "agent:main:main",
      maxBytes: 8 * 1024 * 1024,
      maxEvents: 2_400,
    });
    const record = (await repository.readAllRecords())[0];
    expect(record).toMatchObject({
      agentId: "main",
      sessionId: "session-old",
      sessionKey: "agent:main:main",
      nextSessionId: "session-new",
      status: "complete",
      attemptCount: 1,
      messageCount: 2,
      extractedMessageCount: 2,
      model: "openai/gpt-5.4-mini",
      summary: "Summary text",
      lastError: null,
    });
    expect(record?.transcriptFingerprint).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("marks failures durably and retries them during recovery", async () => {
    const store = createMemoryStore<SessionSummaryRecord>();
    let now = 1_000_000;
    const repository = createRepository({ store, now: () => now });
    const complete = createCompletion("Recovered summary");
    const readBoundedTranscriptEvents = vi
      .fn()
      .mockRejectedValueOnce(new Error("temporary read failure"))
      .mockResolvedValue(createBoundedTranscriptResult());
    const service = new SessionSummaryService({
      repository,
      complete,
      getConfig: () => enabledConfig,
      logger: createLogger(),
      now: () => now,
      readBoundedTranscriptEvents,
    });

    await service.enqueue({
      agentId: "main",
      sessionId: "session-retry",
      sessionKey: "agent:main:main",
      endedAt: Date.now(),
      messageCount: 2,
    });
    await service.waitForIdle();
    expect((await repository.readAllRecords())[0]).toMatchObject({
      status: "failed",
      attemptCount: 1,
      lastError: "temporary read failure",
    });

    now += SESSION_SUMMARY_RETRY_BASE_MS;
    await service.recover();
    await service.waitForIdle();
    expect((await repository.readAllRecords())[0]).toMatchObject({
      status: "complete",
      attemptCount: 2,
      summary: "Recovered summary",
      lastError: null,
    });
  });

  it("fails closed on permanent generation policy errors without reading or retrying", async () => {
    const repository = createRepository();
    const complete = createCompletion();
    const readBoundedTranscriptEvents = vi.fn(async () => createBoundedTranscriptResult());
    const validateGenerationPolicy = vi.fn(() => {
      throw new SessionSummaryPolicyError("model override is not allowed");
    });
    const service = new SessionSummaryService({
      repository,
      complete,
      getConfig: () => enabledConfig,
      logger: createLogger(),
      readBoundedTranscriptEvents,
      validateGenerationPolicy,
    });

    await service.enqueue({
      agentId: "main",
      sessionId: "policy-denied",
      sessionKey: "agent:main:main",
      endedAt: Date.now(),
      messageCount: 2,
    });
    await service.waitForIdle();
    await service.recover();
    await service.waitForIdle();

    expect(validateGenerationPolicy).toHaveBeenCalledTimes(1);
    expect(readBoundedTranscriptEvents).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
    expect((await repository.readAllRecords())[0]).toMatchObject({
      status: "failed",
      attemptCount: 1,
      lastError: "model override is not allowed",
      nextAttemptAt: null,
    });
  });

  it("completes short sessions without spending a model call", async () => {
    const store = createMemoryStore<SessionSummaryRecord>();
    const repository = createRepository({ store });
    const complete = createCompletion();
    const service = new SessionSummaryService({
      repository,
      complete,
      getConfig: () => ({ ...enabledConfig, minMessages: 3 }),
      logger: createLogger(),
      readBoundedTranscriptEvents: vi.fn(async () => createBoundedTranscriptResult()),
    });

    await service.enqueue({
      agentId: "main",
      sessionId: "short",
      sessionKey: "agent:main:main",
      endedAt: Date.now(),
      messageCount: 2,
    });
    await service.waitForIdle();

    expect(complete).not.toHaveBeenCalled();
    expect((await repository.readAllRecords())[0]).toMatchObject({
      status: "complete",
      skipReason: "below_min_messages",
      extractedMessageCount: 2,
      summary: "",
    });
  });

  it("reruns after content grows during a deferred model call and fences the stale result", async () => {
    const store = createMemoryStore<SessionSummaryRecord>();
    const repository = createRepository({ store });
    const firstCompletion = createDeferred<ReturnType<typeof createCompletionResult>>();
    const complete = vi
      .fn()
      .mockImplementationOnce(async () => await firstCompletion.promise)
      .mockResolvedValue(createCompletionResult("fresh result"));
    const readBoundedTranscriptEvents = vi
      .fn()
      .mockResolvedValueOnce(createBoundedTranscriptResult())
      .mockResolvedValue({
        available: true,
        events: [
          ...createTranscriptEvents(),
          { type: "message", message: { role: "user", content: "Include the new scope" } },
        ],
        truncated: false,
      });
    const service = new SessionSummaryService({
      repository,
      complete,
      getConfig: () => enabledConfig,
      logger: createLogger(),
      readBoundedTranscriptEvents,
    });
    const input = {
      agentId: "main",
      sessionId: "stale-worker",
      sessionKey: "agent:main:main",
      endedAt: Date.now(),
      messageCount: 2,
    };

    await service.enqueue(input);
    await vi.waitFor(() => {
      expect(complete).toHaveBeenCalledTimes(1);
    });
    const processing = (await repository.readAllRecords())[0];
    await service.enqueue({ ...input, messageCount: 3 });
    const pending = (await repository.readAllRecords())[0];
    expect(pending).toMatchObject({
      status: "pending",
      messageCount: 3,
      summary: null,
    });
    expect(pending?.revision).toBeGreaterThan(processing?.revision ?? 0);

    firstCompletion.resolve(createCompletionResult("stale result"));
    await service.waitForIdle();

    expect(complete).toHaveBeenCalledTimes(2);
    expect((await repository.readAllRecords())[0]).toMatchObject({
      status: "complete",
      attemptCount: 1,
      messageCount: 3,
      summary: "fresh result",
    });
  });

  it.each([
    {
      name: "missing transcript",
      transcript: { available: false, events: [], truncated: false },
      expectedStatus: "failed",
      expectedCalls: 0,
    },
    {
      name: "available empty transcript",
      transcript: { available: true, events: [], truncated: false },
      expectedStatus: "complete",
      expectedCalls: 0,
    },
    {
      name: "truncated empty transcript",
      transcript: { available: true, events: [], truncated: true },
      expectedStatus: "failed",
      expectedCalls: 0,
    },
    {
      name: "truncated transcript below minMessages",
      transcript: {
        available: true,
        events: [{ type: "message", message: { role: "user", content: "Keep this tail" } }],
        truncated: true,
      },
      expectedStatus: "complete",
      expectedCalls: 1,
    },
  ])("handles $name without turning incomplete reads into permanent skips", async (testCase) => {
    const repository = createRepository();
    const complete = createCompletion("Truncated-tail summary");
    const service = new SessionSummaryService({
      repository,
      complete,
      getConfig: () => ({ ...enabledConfig, minMessages: 3 }),
      logger: createLogger(),
      readBoundedTranscriptEvents: vi.fn(async () => testCase.transcript),
    });

    await service.enqueue({
      agentId: "main",
      sessionId: testCase.name,
      sessionKey: "agent:main:main",
      endedAt: Date.now(),
      messageCount: 1,
    });
    await service.waitForIdle();

    const record = (await repository.readAllRecords())[0];
    expect(record?.status).toBe(testCase.expectedStatus);
    expect(complete).toHaveBeenCalledTimes(testCase.expectedCalls);
    if (testCase.name === "available empty transcript") {
      expect(record).toMatchObject({ skipReason: "below_min_messages", summary: "" });
    }
    if (testCase.name === "truncated transcript below minMessages") {
      expect(record).toMatchObject({ skipReason: null, summary: "Truncated-tail summary" });
    }
    await service.stop();
  });

  it("purges an active deleted session and fences its aborted result", async () => {
    const repository = createRepository();
    const { complete, started } = createAbortableCompletion();
    const service = new SessionSummaryService({
      repository,
      complete,
      getConfig: () => enabledConfig,
      logger: createLogger(),
      readBoundedTranscriptEvents: vi.fn(async () => createBoundedTranscriptResult()),
    });

    await service.enqueue({
      agentId: "main",
      sessionId: "deleted-active",
      sessionKey: "agent:main:main",
      nextSessionId: "successor",
      endedAt: Date.now(),
      messageCount: 2,
    });
    await started;
    await service.enqueue({
      agentId: "main",
      sessionId: "deleted-queued",
      sessionKey: "agent:main:main",
      nextSessionId: "queued-successor",
      endedAt: Date.now(),
      messageCount: 2,
    });
    await service.purge("main", "deleted-queued");
    await service.purge("main", "deleted-active");
    await service.waitForIdle();

    expect(await repository.readAllRecords()).toEqual([]);
    expect(
      await repository.findDirectPredecessor({
        agentId: "main",
        currentSessionId: "successor",
        lookbackDays: 30,
      }),
    ).toBeUndefined();
    expect(
      await repository.findDirectPredecessor({
        agentId: "main",
        currentSessionId: "queued-successor",
        lookbackDays: 30,
      }),
    ).toBeUndefined();
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it("stop settles active work, preserves pending records, and restart recovers both", async () => {
    const repository = createRepository();
    const { complete, started } = createAbortableCompletion();
    const service = new SessionSummaryService({
      repository,
      complete,
      getConfig: () => enabledConfig,
      logger: createLogger(),
      readBoundedTranscriptEvents: vi.fn(async () => createBoundedTranscriptResult()),
    });

    await service.enqueue({
      agentId: "main",
      sessionId: "active-on-stop",
      sessionKey: "agent:main:main",
      endedAt: Date.now(),
      messageCount: 2,
    });
    await started;
    await service.enqueue({
      agentId: "main",
      sessionId: "queued-on-stop",
      sessionKey: "agent:main:main",
      endedAt: Date.now(),
      messageCount: 2,
    });

    await service.stop();
    await service.waitForIdle();

    expect(complete).toHaveBeenCalledTimes(1);
    expect((await repository.readAllRecords()).map((record) => record.status)).toEqual([
      "pending",
      "pending",
    ]);

    complete.mockImplementation(async () => createCompletionResult("Recovered after restart"));
    await service.start();
    await service.waitForIdle();
    expect(complete).toHaveBeenCalledTimes(3);
    expect((await repository.readAllRecords()).map((record) => record.status)).toEqual([
      "complete",
      "complete",
    ]);
  });

  it("stop also fences a bounded transcript reader that never settles", async () => {
    const repository = createRepository();
    const readBoundedTranscriptEvents = vi.fn(
      async () => await new Promise<ReturnType<typeof createBoundedTranscriptResult>>(() => {}),
    );
    const complete = createCompletion();
    const service = new SessionSummaryService({
      repository,
      complete,
      getConfig: () => enabledConfig,
      logger: createLogger(),
      readBoundedTranscriptEvents,
    });

    await service.enqueue({
      agentId: "main",
      sessionId: "stuck-reader",
      sessionKey: "agent:main:main",
      endedAt: Date.now(),
      messageCount: 2,
    });
    await vi.waitFor(() => {
      expect(readBoundedTranscriptEvents).toHaveBeenCalledTimes(1);
    });
    await service.stop();
    await service.waitForIdle();

    expect(complete).not.toHaveBeenCalled();
    expect((await repository.readAllRecords())[0]?.status).toBe("pending");
  });

  it("logs a claim-store failure without losing durable pending work", async () => {
    const baseStore = createMemoryStore<SessionSummaryRecord>();
    let failClaim = true;
    const store: PluginStateKeyedStore<SessionSummaryRecord> = {
      ...baseStore,
      async update(key, updater, options) {
        if (failClaim) {
          throw new Error("claim store unavailable");
        }
        return (await baseStore.update?.(key, updater, options)) ?? false;
      },
    };
    const repository = createRepository({ store });
    const logger = createLogger();
    const complete = createCompletion();
    const service = new SessionSummaryService({
      repository,
      complete,
      getConfig: () => enabledConfig,
      logger,
      readBoundedTranscriptEvents: vi.fn(async () => createBoundedTranscriptResult()),
    });

    await service.enqueue({
      agentId: "main",
      sessionId: "claim-failure",
      sessionKey: "agent:main:main",
      endedAt: Date.now(),
      messageCount: 2,
    });
    await service.waitForIdle();
    expect((await repository.readAllRecords())[0]?.status).toBe("pending");
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("claim store unavailable"));

    failClaim = false;
    await service.recover();
    await service.waitForIdle();
    expect((await repository.readAllRecords())[0]).toMatchObject({
      status: "complete",
      summary: "Summary text",
    });
  });

  it("coalesces concurrent recovery scans", async () => {
    const repository = createRepository();
    const recovery = createDeferred<Array<{ key: string; record: SessionSummaryRecord }>>();
    const listRecoverable = vi
      .spyOn(repository, "listRecoverable")
      .mockImplementation(async () => await recovery.promise);
    const service = new SessionSummaryService({
      repository,
      complete: createCompletion(),
      getConfig: () => enabledConfig,
      logger: createLogger(),
      readBoundedTranscriptEvents: vi.fn(async () => createBoundedTranscriptResult()),
    });

    const first = service.recover();
    const second = service.recover();
    expect(listRecoverable).toHaveBeenCalledTimes(1);
    recovery.resolve([]);
    await Promise.all([first, second]);
    expect(listRecoverable).toHaveBeenCalledTimes(1);
  });

  it("keeps a claim lease-recoverable when persisting the failure itself throws", async () => {
    const baseStore = createMemoryStore<SessionSummaryRecord>();
    let updateCount = 0;
    const store: PluginStateKeyedStore<SessionSummaryRecord> = {
      ...baseStore,
      async update(key, updater, options) {
        updateCount += 1;
        if (updateCount === 2) {
          throw new Error("markFailed store unavailable");
        }
        return (await baseStore.update?.(key, updater, options)) ?? false;
      },
    };
    let now = 2_000_000;
    const repository = createRepository({ store, now: () => now });
    const logger = createLogger();
    const readBoundedTranscriptEvents = vi
      .fn()
      .mockRejectedValueOnce(new Error("transcript read failed"))
      .mockResolvedValue(createBoundedTranscriptResult());
    const service = new SessionSummaryService({
      repository,
      complete: createCompletion("Recovered after lease"),
      getConfig: () => enabledConfig,
      logger,
      now: () => now,
      readBoundedTranscriptEvents,
    });

    await service.enqueue({
      agentId: "main",
      sessionId: "mark-failure",
      sessionKey: "agent:main:main",
      endedAt: now,
      messageCount: 2,
    });
    await service.waitForIdle();
    expect((await repository.readAllRecords())[0]?.status).toBe("processing");
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("markFailed store unavailable"),
    );

    now += SESSION_SUMMARY_PROCESSING_LEASE_MS;
    await service.recover();
    await service.waitForIdle();
    expect((await repository.readAllRecords())[0]).toMatchObject({
      status: "complete",
      attemptCount: 2,
      summary: "Recovered after lease",
    });
  });
});

describe("SessionSummaryRepository queries", () => {
  async function seedSummary(params: {
    repository: SessionSummaryRepository;
    agentId?: string;
    sessionId: string;
    endedAt: number;
    summary: string;
  }) {
    const enqueued = await params.repository.enqueue({
      agentId: params.agentId ?? "main",
      sessionId: params.sessionId,
      sessionKey: `agent:${params.agentId ?? "main"}:${params.sessionId}`,
      endedAt: params.endedAt,
      messageCount: 3,
    });
    const claimed = await params.repository.claim(enqueued.key);
    if (!claimed) {
      throw new Error("expected seeded summary claim");
    }
    await params.repository.markComplete(enqueued.key, {
      extractedMessageCount: 3,
      expectedRevision: claimed.revision,
      fingerprint: params.sessionId.padEnd(64, "0").slice(0, 64),
      generatedAt: params.endedAt,
      model: "openai/gpt-5.4-mini",
      summary: params.summary,
    });
  }

  it("keeps equal duplicate counts idempotent and requeues a completed skip when content grows", async () => {
    const store = createMemoryStore<SessionSummaryRecord>();
    const repository = createRepository({ store });
    const input = {
      agentId: "main",
      sessionId: "growing-session",
      sessionKey: "agent:main:main",
      endedAt: Date.now(),
      messageCount: 2,
    };
    const initial = await repository.enqueue(input);
    const claimed = await repository.claim(initial.key);
    if (!claimed) {
      throw new Error("expected growing-session claim");
    }
    await repository.markComplete(initial.key, {
      extractedMessageCount: 2,
      expectedRevision: claimed.revision,
      fingerprint: "skip".padEnd(64, "0"),
      generatedAt: Date.now(),
      model: null,
      skipReason: "below_min_messages",
      summary: "",
    });

    const equalDuplicate = await repository.enqueue(input);
    expect(equalDuplicate.shouldProcess).toBe(false);
    expect(equalDuplicate.record).toMatchObject({
      status: "complete",
      messageCount: 2,
      skipReason: "below_min_messages",
    });

    const grownDuplicate = await repository.enqueue({ ...input, messageCount: 3 });
    expect(grownDuplicate.shouldProcess).toBe(true);
    expect(grownDuplicate.record).toMatchObject({
      status: "pending",
      messageCount: 3,
      transcriptFingerprint: null,
      extractedMessageCount: null,
      generatedAt: null,
      summary: null,
      skipReason: null,
    });
  });

  it("only reclaims processing work after its durable lease expires", async () => {
    let now = 3_000_000;
    const repository = createRepository({ now: () => now });
    const enqueued = await repository.enqueue({
      agentId: "main",
      sessionId: "leased",
      sessionKey: "agent:main:main",
      endedAt: now,
      messageCount: 2,
    });
    const firstClaim = await repository.claim(enqueued.key);
    if (!firstClaim) {
      throw new Error("expected first leased claim");
    }

    expect(await repository.claim(enqueued.key)).toBeUndefined();
    now += SESSION_SUMMARY_PROCESSING_LEASE_MS - 1;
    expect(await repository.claim(enqueued.key)).toBeUndefined();
    now += 1;
    const secondClaim = await repository.claim(enqueued.key);

    expect(secondClaim).toMatchObject({ status: "processing", attemptCount: 2 });
    expect(secondClaim?.revision).toBeGreaterThan(firstClaim.revision);
  });

  it("honors retry backoff and resets it when generation config changes", async () => {
    const now = 4_000_000;
    const repository = createRepository({ now: () => now });
    const input = {
      agentId: "main",
      sessionId: "backoff",
      sessionKey: "agent:main:main",
      endedAt: now,
      messageCount: 2,
      generationConfigFingerprint: "config-a",
    };
    const enqueued = await repository.enqueue(input);
    const claimed = await repository.claim(enqueued.key);
    if (!claimed) {
      throw new Error("expected backoff claim");
    }
    const failed = await repository.markFailed(enqueued.key, "temporary", now, claimed.revision);

    expect(failed).toMatchObject({
      status: "failed",
      nextAttemptAt: now + SESSION_SUMMARY_RETRY_BASE_MS,
    });
    expect((await repository.enqueue(input)).shouldProcess).toBe(false);
    const reset = await repository.enqueue({
      ...input,
      generationConfigFingerprint: "config-b",
    });
    expect(reset).toMatchObject({
      shouldProcess: true,
      record: {
        status: "pending",
        attemptCount: 0,
        nextAttemptAt: null,
        lastError: null,
      },
    });
  });

  it("chooses the same predecessor deterministically when endedAt ties", async () => {
    const repository = createRepository();
    const endedAt = Date.now();
    for (const [currentSessionId, order] of [
      ["current-a", ["zeta", "alpha"]],
      ["current-b", ["alpha", "zeta"]],
    ] as const) {
      for (const sessionId of order) {
        await repository.enqueue({
          agentId: "main",
          sessionId,
          sessionKey: "agent:main:main",
          nextSessionId: currentSessionId,
          endedAt,
          messageCount: 2,
        });
      }
      expect(
        await repository.findDirectPredecessor({
          agentId: "main",
          currentSessionId,
          lookbackDays: 30,
        }),
      ).toMatchObject({ sessionId: "alpha" });
    }
  });

  it("uses literal keyword matching and cursor pagination within one agent", async () => {
    const store = createMemoryStore<SessionSummaryRecord>();
    const repository = createRepository({ store });
    const now = Date.now();
    await seedSummary({ repository, sessionId: "one", endedAt: now, summary: "Reached 95%" });
    await seedSummary({
      repository,
      sessionId: "two",
      endedAt: now - 1,
      summary: "No wildcard here",
    });
    await seedSummary({
      repository,
      agentId: "other",
      sessionId: "three",
      endedAt: now - 2,
      summary: "Reached 50%",
    });

    const literal = await repository.list({
      agentId: "main",
      lookbackDays: 30,
      query: "%",
      limit: 10,
    });
    expect(literal.items.map((item) => item.sessionId)).toEqual(["one"]);

    const firstPage = await repository.list({
      agentId: "main",
      lookbackDays: 30,
      limit: 1,
    });
    expect(firstPage.items.map((item) => item.sessionId)).toEqual(["one"]);
    expect(firstPage.nextCursor).toBeTruthy();
    expect(firstPage.nextCursor?.length).toBeLessThan(512);
    expect(firstPage.items[0]).not.toHaveProperty("revision");
    expect(firstPage.items[0]).not.toHaveProperty("nextAttemptAt");
    expect(firstPage.items[0]).not.toHaveProperty("leaseExpiresAt");
    const secondPage = await repository.list({
      agentId: "main",
      lookbackDays: 30,
      limit: 1,
      cursor: firstPage.nextCursor,
    });
    expect(secondPage.items.map((item) => item.sessionId)).toEqual(["two"]);
    expect(secondPage.nextCursor).toBeUndefined();
  });

  it("rejects literal queries beyond the hard character bound", async () => {
    const store = createMemoryStore<SessionSummaryRecord>();
    const repository = createRepository({ store });

    await expect(
      repository.list({
        agentId: "main",
        lookbackDays: 30,
        query: "q".repeat(513),
      }),
    ).rejects.toThrow("at most 512 characters");
  });

  it("rejects invalid cursors before scanning stored summaries", async () => {
    const store = createMemoryStore<SessionSummaryRecord>();
    const entries = vi.spyOn(store, "entries");
    const repository = createRepository({ store });

    await expect(
      repository.list({
        agentId: "main",
        lookbackDays: 30,
        cursor: "x".repeat(2_049),
      }),
    ).rejects.toThrow("invalid session summaries cursor");
    expect(entries).not.toHaveBeenCalled();
  });
});
