import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type {
  OpenClawPluginApi,
  OpenClawPluginToolContext,
  OpenClawPluginToolFactory,
} from "openclaw/plugin-sdk/plugin-entry";
import type {
  PluginStateEntry,
  PluginStateKeyedStore,
} from "openclaw/plugin-sdk/plugin-state-runtime";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { describe, expect, it, vi } from "vitest";
import {
  registerSessionSummaries,
  type RegisterSessionSummariesOptions,
} from "./session-summaries-plugin.js";
import type {
  SessionSummaryPublicRecord,
  SessionSummaryPredecessorIndexRecord,
  SessionSummaryRecord,
} from "./session-summaries-store.js";
import {
  boundSessionSummaryToolResponse,
  SESSION_SUMMARY_TOOL_RESPONSE_MAX_TOKENS,
} from "./session-summaries-tool.js";
import { estimateSessionSummaryTokens } from "./session-summaries-transcript.js";

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

type BeforePromptBuildHook = (
  event: { prompt: string; messages: unknown[] },
  ctx: {
    runId?: string;
    agentId?: string;
    sessionId?: string;
    sessionKey?: string;
    nativeSessionRebuild?: boolean;
  },
) => Promise<{ prependContext?: string } | void> | { prependContext?: string } | void;

type AgentEndHook = (
  event: { runId?: string; messages: unknown[]; success: boolean; error?: string },
  ctx: { runId?: string; agentId?: string; sessionId?: string; sessionKey?: string },
) => Promise<void> | void;

type ReplyDispatchCompletedHook = (
  event: {
    runId?: string;
    success: boolean;
    queuedFinal: boolean;
    counts: { tool: number; block: number; final: number };
    failedCounts?: { tool?: number; block?: number; final?: number };
  },
  ctx: { runId?: string; sessionKey?: string },
) => Promise<void> | void;

type GatewayHandler = (ctx: {
  params: Record<string, unknown>;
  respond: (ok: boolean, result?: unknown, error?: { code: string; message: string }) => void;
}) => unknown;

type SessionEndHook = (
  event: {
    sessionId: string;
    sessionKey?: string;
    messageCount: number;
    reason?:
      | "new"
      | "reset"
      | "idle"
      | "daily"
      | "compaction"
      | "deleted"
      | "shutdown"
      | "restart"
      | "unknown";
    nextSessionId?: string;
    sessionFile?: string;
    transcriptArchived?: boolean;
  },
  ctx: { agentId?: string; sessionId: string; sessionKey?: string },
) => Promise<void> | void;

async function completeQueuedSummary(
  service: ReturnType<typeof registerSessionSummaries>,
  key: string,
  params: { sessionId: string; summary: string },
) {
  const claimed = await service.repository.claim(key);
  if (!claimed) {
    throw new Error("expected queued summary claim");
  }
  await service.repository.markComplete(key, {
    extractedMessageCount: 3,
    expectedRevision: claimed.revision,
    fingerprint: params.sessionId.padEnd(64, "0").slice(0, 64),
    generatedAt: Date.now(),
    model: "openai/gpt-5.4-mini",
    summary: params.summary,
  });
}

function createCompletionResult(text: string, agentId = "main") {
  return {
    text,
    provider: "openai",
    model: "gpt-5.4-mini",
    agentId,
    usage: {},
    audit: { caller: { kind: "plugin" as const } },
  };
}

function registerTestSessionSummaries(params: {
  cfg: OpenClawConfig;
  complete?: OpenClawPluginApi["runtime"]["llm"]["complete"];
  now?: NonNullable<RegisterSessionSummariesOptions["now"]>;
  readBoundedTranscriptEvents?: NonNullable<
    RegisterSessionSummariesOptions["readBoundedTranscriptEvents"]
  >;
  resolveBackfillCandidates?: NonNullable<
    RegisterSessionSummariesOptions["resolveBackfillCandidates"]
  >;
}) {
  const hooks = new Map<string, unknown>();
  const gatewayHandlers = new Map<string, GatewayHandler>();
  const injectionStore = createMemoryStore<unknown>();
  const summaryStore = createMemoryStore<SessionSummaryRecord>();
  const predecessorIndexStore = createMemoryStore<SessionSummaryPredecessorIndexRecord>();
  const complete =
    params.complete ?? vi.fn(async () => createCompletionResult("Generated summary"));
  const readBoundedTranscriptEvents =
    params.readBoundedTranscriptEvents ??
    vi.fn(async () => ({
      available: true,
      events: [
        { type: "message", message: { role: "user", content: "Plan the migration" } },
        { type: "message", message: { role: "assistant", content: "Use staged commits" } },
      ],
      truncated: false,
    }));
  let registeredService: Parameters<OpenClawPluginApi["registerService"]>[0] | undefined;
  const runtime = {
    config: { current: () => params.cfg },
    state: { openKeyedStore: vi.fn(() => injectionStore) },
    llm: { complete },
  } as unknown as OpenClawPluginApi["runtime"];
  const api = createTestPluginApi({
    id: "memory-core",
    config: params.cfg,
    pluginConfig: params.cfg.plugins?.entries?.["memory-core"]?.config,
    runtime,
    on(name, handler) {
      hooks.set(name, handler);
    },
    registerGatewayMethod(method, handler) {
      gatewayHandlers.set(method, handler as GatewayHandler);
    },
    registerService(service) {
      registeredService = service;
    },
  });
  const service = registerSessionSummaries(api, {
    predecessorIndexStore,
    readBoundedTranscriptEvents,
    ...(params.now ? { now: params.now } : {}),
    ...(params.resolveBackfillCandidates
      ? { resolveBackfillCandidates: params.resolveBackfillCandidates }
      : {}),
    summaryStore,
  });
  return {
    complete,
    gatewayHandlers,
    hooks,
    injectionStore,
    predecessorIndexStore,
    readBoundedTranscriptEvents,
    registeredService: () => registeredService,
    service,
    summaryStore,
  };
}

describe("session summaries plugin registration", () => {
  it("injects a visible bounded predecessor lineage once and exposes scoped tool/RPC reads", async () => {
    const cfg = {
      agents: { list: [{ id: "main", default: true }] },
      plugins: {
        entries: {
          "memory-core": {
            config: {
              summaries: {
                enabled: true,
                autoInject: true,
                lookbackDays: 30,
                maxPromptTokens: 4_000,
                minMessages: 2,
              },
            },
          },
        },
      },
    } satisfies OpenClawConfig;
    const store = createMemoryStore<SessionSummaryRecord>();
    const injectionStore = createMemoryStore<unknown>();
    const predecessorIndexStore = createMemoryStore<SessionSummaryPredecessorIndexRecord>();
    const entriesSpy = vi.spyOn(store, "entries");
    const readBoundedTranscriptEvents = vi.fn(async () => ({
      available: true,
      events: [{ type: "message", message: { role: "user", content: "must not inject" } }],
      truncated: false,
    }));
    const hooks = new Map<string, unknown>();
    let toolFactory: OpenClawPluginToolFactory | undefined;
    let gatewayHandler: GatewayHandler | undefined;
    let registeredService: Parameters<OpenClawPluginApi["registerService"]>[0] | undefined;
    const runtime = {
      config: { current: () => cfg },
      state: { openKeyedStore: () => injectionStore },
      llm: {
        complete: vi.fn(async () => ({
          text: "unused",
          provider: "openai",
          model: "gpt-5.4-mini",
          agentId: "main",
          usage: {},
          audit: { caller: { kind: "plugin" as const } },
        })),
      },
    } as unknown as OpenClawPluginApi["runtime"];
    const api = createTestPluginApi({
      id: "memory-core",
      config: cfg,
      pluginConfig: cfg.plugins?.entries?.["memory-core"]?.config,
      runtime,
      on(name, handler) {
        hooks.set(name, handler);
      },
      registerTool(tool) {
        if (typeof tool === "function") {
          toolFactory = tool;
        }
      },
      registerGatewayMethod(method, handler) {
        if (method === "memory.summaries.list") {
          gatewayHandler = handler as GatewayHandler;
        }
      },
      registerService(service) {
        registeredService = service;
      },
    });
    const service = registerSessionSummaries(api, {
      predecessorIndexStore,
      readBoundedTranscriptEvents,
      summaryStore: store,
    });
    expect(registeredService?.id).toBe("memory-core-session-summaries");

    async function seed(params: {
      agentId?: string;
      sessionId: string;
      sessionKey: string;
      nextSessionId?: string;
      summary: string;
      endedAt: number;
    }) {
      const enqueued = await service.repository.enqueue({
        agentId: params.agentId ?? "main",
        sessionId: params.sessionId,
        sessionKey: params.sessionKey,
        endedAt: params.endedAt,
        messageCount: 3,
        ...(params.nextSessionId ? { nextSessionId: params.nextSessionId } : {}),
      });
      const claimed = await service.repository.claim(enqueued.key);
      if (!claimed) {
        throw new Error("expected seeded summary claim");
      }
      await service.repository.markComplete(enqueued.key, {
        extractedMessageCount: 3,
        expectedRevision: claimed.revision,
        fingerprint: params.sessionId.padEnd(64, "0").slice(0, 64),
        generatedAt: params.endedAt,
        model: "openai/gpt-5.4-mini",
        summary: params.summary,
      });
    }

    async function seedFailed(params: {
      sessionId: string;
      sessionKey: string;
      nextSessionId: string;
      endedAt: number;
    }) {
      const enqueued = await service.repository.enqueue({
        agentId: "main",
        sessionId: params.sessionId,
        sessionKey: params.sessionKey,
        nextSessionId: params.nextSessionId,
        endedAt: params.endedAt,
        messageCount: 3,
      });
      const claimed = await service.repository.claim(enqueued.key);
      if (!claimed) {
        throw new Error("expected failed summary claim");
      }
      await service.repository.markFailed(
        enqueued.key,
        "generation failed",
        params.endedAt,
        claimed.revision,
        { retryable: false },
      );
    }

    const now = Date.now();
    await seed({
      sessionId: "older-two",
      sessionKey: "agent:main:main",
      nextSessionId: "pending-gap",
      summary: "Relationship context: the user prefers direct progress updates.",
      endedAt: now - 4,
    });
    await service.repository.enqueue({
      agentId: "main",
      sessionId: "pending-gap",
      sessionKey: "agent:main:main",
      nextSessionId: "failed-gap",
      endedAt: now - 3,
      messageCount: 3,
    });
    await seedFailed({
      sessionId: "failed-gap",
      sessionKey: "agent:main:main",
      nextSessionId: "older-one",
      endedAt: now - 2,
    });
    await seed({
      sessionId: "older-one",
      sessionKey: "agent:main:main",
      nextSessionId: "previous",
      summary: "Earlier decision: keep the streaming backend persistent.",
      endedAt: now - 1,
    });
    await seed({
      sessionId: "previous",
      sessionKey: "agent:main:main",
      nextSessionId: "current",
      summary: `Migration reached 95%. ${"bounded detail ".repeat(100)}`,
      endedAt: now,
    });
    await seed({
      sessionId: "not-direct",
      sessionKey: "agent:main:main",
      nextSessionId: "another",
      summary: "This must not be injected.",
      endedAt: now + 1,
    });
    await seed({
      sessionId: "hidden-tree-sibling",
      sessionKey: "agent:main:sibling",
      nextSessionId: "hidden-current",
      summary: "Migration sibling details",
      endedAt: now - 1,
    });
    await seed({
      agentId: "other",
      sessionId: "other-agent",
      sessionKey: "agent:other:main",
      summary: "Migration other-agent details",
      endedAt: now - 2,
    });

    const beforePromptBuild = hooks.get("before_prompt_build") as BeforePromptBuildHook;
    expect(entriesSpy).not.toHaveBeenCalled();
    expect(
      await beforePromptBuild(
        { prompt: "continue", messages: [] },
        { agentId: "main", sessionId: "hidden-current", sessionKey: "agent:main:main" },
      ),
    ).toBeUndefined();

    const skipped = await service.repository.enqueue({
      agentId: "main",
      sessionId: "skipped-predecessor",
      sessionKey: "agent:main:main",
      nextSessionId: "after-skipped",
      endedAt: now + 2,
      messageCount: 1,
    });
    const skippedClaim = await service.repository.claim(skipped.key);
    if (!skippedClaim) {
      throw new Error("expected skipped predecessor claim");
    }
    await service.repository.markComplete(skipped.key, {
      extractedMessageCount: 1,
      expectedRevision: skippedClaim.revision,
      fingerprint: "skipped".padEnd(64, "0"),
      generatedAt: now + 2,
      model: null,
      skipReason: "below_min_messages",
      summary: "",
    });
    expect(
      await beforePromptBuild(
        { prompt: "continue", messages: [] },
        { agentId: "main", sessionId: "after-skipped", sessionKey: "agent:main:main" },
      ),
    ).toBeUndefined();
    expect(readBoundedTranscriptEvents).not.toHaveBeenCalled();
    await expect(
      beforePromptBuild(
        { prompt: "continue with history", messages: [{ role: "user", content: "existing" }] },
        { agentId: "main", sessionId: "current", sessionKey: "agent:main:main" },
      ),
    ).resolves.toBeUndefined();
    await expect(injectionStore.entries()).resolves.toHaveLength(0);
    const concurrentInjections = await Promise.all([
      beforePromptBuild(
        { prompt: "continue", messages: [] },
        { agentId: "main", sessionId: "current", sessionKey: "agent:main:main" },
      ),
      beforePromptBuild(
        { prompt: "continue concurrently", messages: [] },
        { agentId: "main", sessionId: "current", sessionKey: "agent:main:main" },
      ),
    ]);
    const injection = concurrentInjections.find(
      (candidate): candidate is { prependContext?: string } => candidate !== undefined,
    );
    expect(concurrentInjections.filter(Boolean)).toHaveLength(1);
    expect(injection?.prependContext).toContain("previous_session_summary");
    expect(injection?.prependContext).toContain("Migration reached 95%");
    expect(injection?.prependContext).toContain("streaming backend persistent");
    expect(injection?.prependContext).toContain("direct progress updates");
    expect(injection?.prependContext).not.toContain("This must not be injected");
    expect(estimateSessionSummaryTokens(injection?.prependContext ?? "")).toBeLessThanOrEqual(
      2_000,
    );
    expect(injection?.prependContext?.length).toBeLessThanOrEqual(8_000);
    expect(entriesSpy).not.toHaveBeenCalled();
    await expect(
      beforePromptBuild(
        { prompt: "continue again", messages: [] },
        { agentId: "main", sessionId: "current", sessionKey: "agent:main:main" },
      ),
    ).resolves.toBeUndefined();
    await expect(injectionStore.entries()).resolves.toHaveLength(1);

    await seed({
      sessionId: "huge-older",
      sessionKey: "agent:main:main",
      nextSessionId: "huge-newest",
      summary: "OLDER_LINEAGE_MUST_STOP_AT_BOUNDARY",
      endedAt: now + 2,
    });
    await seed({
      sessionId: "huge-newest",
      sessionKey: "agent:main:main",
      nextSessionId: "huge-current",
      summary: `NEWEST_BOUNDARY ${"detail ".repeat(4_000)}`,
      endedAt: now + 3,
    });
    const boundaryInjection = await beforePromptBuild(
      { prompt: "continue", messages: [] },
      { agentId: "main", sessionId: "huge-current", sessionKey: "agent:main:main" },
    );
    expect(boundaryInjection?.prependContext).toContain("NEWEST_BOUNDARY");
    expect(boundaryInjection?.prependContext).not.toContain("OLDER_LINEAGE_MUST_STOP_AT_BOUNDARY");
    expect(boundaryInjection?.prependContext?.length).toBeLessThanOrEqual(8_000);
    expect(
      estimateSessionSummaryTokens(boundaryInjection?.prependContext ?? ""),
    ).toBeLessThanOrEqual(2_000);

    await seed({
      sessionId: "post-boundary-oldest",
      sessionKey: "agent:main:main",
      nextSessionId: "post-boundary-large",
      summary: "POST_BOUNDARY_OLDEST_MUST_NOT_APPEAR",
      endedAt: now + 4,
    });
    await seed({
      sessionId: "post-boundary-large",
      sessionKey: "agent:main:main",
      nextSessionId: "small-newest",
      summary: `OLDER_TOO_LARGE_MUST_NOT_BE_PARTIAL ${"detail ".repeat(4_000)}`,
      endedAt: now + 5,
    });
    await seed({
      sessionId: "small-newest",
      sessionKey: "agent:main:main",
      nextSessionId: "small-current",
      summary: "SMALL_NEWEST_FULL",
      endedAt: now + 6,
    });
    const olderBoundaryInjection = await beforePromptBuild(
      { prompt: "continue", messages: [] },
      { agentId: "main", sessionId: "small-current", sessionKey: "agent:main:main" },
    );
    expect(olderBoundaryInjection?.prependContext).toContain("SMALL_NEWEST_FULL");
    expect(olderBoundaryInjection?.prependContext).not.toContain(
      "OLDER_TOO_LARGE_MUST_NOT_BE_PARTIAL",
    );
    expect(olderBoundaryInjection?.prependContext).not.toContain(
      "POST_BOUNDARY_OLDEST_MUST_NOT_APPEAR",
    );

    const registeredTool = toolFactory?.({
      agentId: "main",
      sessionKey: "agent:main:main",
      sandboxed: false,
      config: cfg,
    } as OpenClawPluginToolContext);
    const tool = Array.isArray(registeredTool) ? registeredTool[0] : registeredTool;
    if (!tool) {
      throw new Error("expected session_summaries tool");
    }
    expect(
      (
        tool.parameters as {
          properties?: {
            cursor?: { maxLength?: number };
            query?: { maxLength?: number };
          };
        }
      ).properties?.query?.maxLength,
    ).toBe(512);
    expect(
      (
        tool.parameters as {
          properties?: { cursor?: { maxLength?: number } };
        }
      ).properties?.cursor?.maxLength,
    ).toBe(2_048);
    const toolResult = await tool.execute("call-1", { query: "Migration", limit: 20 });
    const toolDetails = toolResult?.details as
      | { summaries?: Array<{ sessionId: string }> }
      | undefined;
    expect(toolDetails?.summaries?.map((item) => item.sessionId)).toEqual(["previous"]);

    (cfg.plugins.entries["memory-core"].config.summaries as { enabled: boolean }).enabled = false;
    const storedResult = await tool.execute("call-2", { query: "Migration", limit: 20 });
    const storedDetails = storedResult?.details as
      | { summaries?: Array<{ sessionId: string }> }
      | undefined;
    expect(storedDetails?.summaries?.map((item) => item.sessionId)).toEqual(["previous"]);

    const respond = vi.fn();
    await gatewayHandler?.({
      params: { agentId: "main", limit: 2, query: "This must not be injected" },
      respond,
    });
    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        items: expect.arrayContaining([
          expect.objectContaining({ agentId: "main", sessionId: "not-direct" }),
        ]),
      }),
    );
    const rpcPayload = respond.mock.calls[0]?.[1] as { items?: unknown[] } | undefined;
    expect(rpcPayload?.items).toHaveLength(1);

    respond.mockClear();
    await gatewayHandler?.({
      params: { agentId: "main", query: "q".repeat(513) },
      respond,
    });
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "invalid_request" }),
    );

    const baseItem = rpcPayload?.items?.[0] as SessionSummaryPublicRecord | undefined;
    if (!baseItem) {
      throw new Error("expected an RPC summary item");
    }
    const bounded = boundSessionSummaryToolResponse({
      items: Array.from({ length: 20 }, (_, index) => ({
        ...baseItem,
        sessionId: `oversized-${index}`,
        summary: "界".repeat(24_000),
      })),
      nextCursor: "opaque-cursor",
    });
    expect(bounded.summaries).toHaveLength(20);
    expect(bounded.summaries.every((item) => item.summaryTruncated === true)).toBe(true);
    expect(bounded.summaries.map((item) => item.sessionId)).toEqual(
      Array.from({ length: 20 }, (_, index) => `oversized-${index}`),
    );
    expect(estimateSessionSummaryTokens(JSON.stringify(bounded, null, 2))).toBeLessThanOrEqual(
      SESSION_SUMMARY_TOOL_RESPONSE_MAX_TOKENS,
    );

    const pathologicalMetadata = boundSessionSummaryToolResponse({
      items: Array.from({ length: 20 }, (_, index) => ({
        ...baseItem,
        sessionId: `pathological-${index}-${"会".repeat(20_000)}`,
        sessionKey: `agent:main:${"界".repeat(20_000)}`,
        lastError: "错".repeat(20_000),
        summary: "bounded",
      })),
      nextCursor: "opaque-cursor",
    });
    expect(pathologicalMetadata.summaries.length).toBeGreaterThan(0);
    expect(pathologicalMetadata.summaries.every((item) => item.metadataTruncated === true)).toBe(
      true,
    );
    expect(
      estimateSessionSummaryTokens(JSON.stringify(pathologicalMetadata, null, 2)),
    ).toBeLessThanOrEqual(SESSION_SUMMARY_TOOL_RESPONSE_MAX_TOKENS);
  });

  it("reuses a run-scoped injection across retries and commits it only after success", async () => {
    const cfg = {
      agents: { list: [{ id: "main", default: true }] },
      plugins: {
        entries: {
          "memory-core": {
            config: {
              summaries: {
                enabled: true,
                autoInject: true,
                lookbackDays: 30,
                maxPromptTokens: 4_000,
                minMessages: 2,
              },
            },
          },
        },
      },
    } satisfies OpenClawConfig;
    const { hooks, injectionStore, service } = registerTestSessionSummaries({ cfg });
    await service.repository.enqueue({
      agentId: "main",
      sessionId: "previous",
      sessionKey: "agent:main:main",
      nextSessionId: "current",
      endedAt: Date.now(),
      messageCount: 2,
    });
    const beforePromptBuild = hooks.get("before_prompt_build") as BeforePromptBuildHook;
    const agentEnd = hooks.get("agent_end") as AgentEndHook;
    const replyDispatchCompleted = hooks.get(
      "reply_dispatch_completed",
    ) as ReplyDispatchCompletedHook;
    const context = {
      agentId: "main",
      sessionId: "current",
      sessionKey: "agent:main:main",
    };

    const failedRunInjection = await beforePromptBuild(
      { prompt: "continue", messages: [] },
      { ...context, runId: "failed-run" },
    );
    const failedRunRetry = await beforePromptBuild(
      { prompt: "retry", messages: [{ role: "assistant", content: "failed attempt" }] },
      { ...context, runId: "failed-run" },
    );
    expect(failedRunRetry).toEqual(failedRunInjection);
    await expect(injectionStore.entries()).resolves.toHaveLength(0);

    await agentEnd(
      { runId: "failed-run", messages: [], success: false, error: "provider failed" },
      { ...context, runId: "failed-run" },
    );
    const recoveryRunInjection = await beforePromptBuild(
      {
        prompt: "retry after terminal run failure",
        messages: [{ role: "assistant", content: "provider failed" }],
      },
      { ...context, runId: "recovery-run" },
    );
    expect(recoveryRunInjection).toEqual(failedRunInjection);
    await expect(injectionStore.entries()).resolves.toHaveLength(0);

    await agentEnd(
      { runId: "recovery-run", messages: [], success: true },
      { ...context, runId: "recovery-run" },
    );
    const retryAfterAttemptSuccess = await beforePromptBuild(
      { prompt: "outer retry", messages: [] },
      { ...context, runId: "recovery-run" },
    );
    expect(retryAfterAttemptSuccess).toEqual(failedRunInjection);
    await expect(injectionStore.entries()).resolves.toHaveLength(0);

    await agentEnd(
      { runId: "recovery-run", messages: [], success: true },
      { ...context, runId: "recovery-run" },
    );
    const overlappingRunInjection = await beforePromptBuild(
      {
        prompt: "overlap while delivery settles",
        messages: [{ role: "assistant", content: "done" }],
      },
      { ...context, runId: "delivery-recovery-run" },
    );
    expect(overlappingRunInjection).toEqual(failedRunInjection);
    await replyDispatchCompleted(
      {
        runId: "recovery-run",
        success: false,
        queuedFinal: false,
        counts: { tool: 0, block: 0, final: 0 },
        failedCounts: { final: 1 },
      },
      { runId: "recovery-run", sessionKey: context.sessionKey },
    );
    await expect(injectionStore.entries()).resolves.toHaveLength(0);
    await agentEnd(
      { runId: "delivery-recovery-run", messages: [], success: true },
      { ...context, runId: "delivery-recovery-run" },
    );
    await replyDispatchCompleted(
      {
        runId: "delivery-recovery-run",
        success: true,
        queuedFinal: false,
        counts: { tool: 0, block: 0, final: 0 },
      },
      { runId: "delivery-recovery-run", sessionKey: context.sessionKey },
    );
    await expect(injectionStore.entries()).resolves.toHaveLength(1);
    await expect(
      beforePromptBuild(
        { prompt: "continue again", messages: [] },
        { ...context, runId: "later-run" },
      ),
    ).resolves.toBeUndefined();
  });

  it("injects a bounded pending predecessor tail immediately and purges it on delete", async () => {
    const cfg = {
      agents: { list: [{ id: "main", default: true }] },
      plugins: {
        entries: {
          "memory-core": {
            config: {
              summaries: {
                enabled: true,
                autoInject: true,
                lookbackDays: 30,
                maxPromptTokens: 4_000,
                minMessages: 2,
              },
            },
          },
        },
      },
    } satisfies OpenClawConfig;
    const complete = vi.fn(
      async (params: Parameters<OpenClawPluginApi["runtime"]["llm"]["complete"]>[0]) =>
        await new Promise<ReturnType<typeof createCompletionResult>>((_resolve, reject) => {
          params.signal?.addEventListener(
            "abort",
            () => {
              const reason = params.signal?.reason;
              reject(reason instanceof Error ? reason : new Error("aborted"));
            },
            { once: true },
          );
        }),
    );
    const readBoundedTranscriptEvents = vi.fn(async () => ({
      available: true,
      events: [
        { type: "message", message: { role: "user", content: "Keep the rollout staged" } },
        {
          type: "message",
          message: { role: "assistant", content: "The next step is the canary" },
        },
      ],
      truncated: false,
    }));
    const harness = registerTestSessionSummaries({
      cfg,
      complete,
      readBoundedTranscriptEvents,
    });
    const sessionEnd = harness.hooks.get("session_end") as SessionEndHook;
    const beforePromptBuild = harness.hooks.get("before_prompt_build") as BeforePromptBuildHook;
    const entriesSpy = vi.spyOn(harness.summaryStore, "entries");

    await sessionEnd(
      {
        sessionId: "previous",
        messageCount: 2,
        reason: "reset",
        nextSessionId: "current",
      },
      { agentId: "main", sessionId: "previous", sessionKey: "agent:main:main" },
    );
    await vi.waitFor(() => {
      expect(complete).toHaveBeenCalledTimes(1);
    });

    const injection = await beforePromptBuild(
      { prompt: "continue", messages: [] },
      { agentId: "main", sessionId: "current", sessionKey: "agent:main:main" },
    );
    expect(injection?.prependContext).toContain("previous_session_tail");
    expect(injection?.prependContext).toContain("Keep the rollout staged");
    expect(estimateSessionSummaryTokens(injection?.prependContext ?? "")).toBeLessThanOrEqual(
      1_200,
    );
    expect(readBoundedTranscriptEvents).toHaveBeenCalledWith(
      expect.objectContaining({ maxBytes: 512 * 1024, maxEvents: 200 }),
    );
    expect(entriesSpy).not.toHaveBeenCalled();

    await sessionEnd(
      { sessionId: "previous", messageCount: 2, reason: "deleted" },
      { agentId: "main", sessionId: "previous" },
    );
    await harness.service.waitForIdle();
    expect(
      await beforePromptBuild(
        { prompt: "continue", messages: [] },
        { agentId: "main", sessionId: "current", sessionKey: "agent:main:main" },
      ),
    ).toBeUndefined();
    expect(await harness.service.repository.readAllRecords()).toEqual([]);
  });

  it("upgrades a provisional tail injection to the formal summary once generation finishes", async () => {
    const cfg = {
      agents: { list: [{ id: "main", default: true }] },
      plugins: {
        entries: {
          "memory-core": {
            config: {
              summaries: {
                enabled: true,
                autoInject: true,
                lookbackDays: 30,
                maxPromptTokens: 4_000,
                minMessages: 2,
              },
            },
          },
        },
      },
    } satisfies OpenClawConfig;
    const readBoundedTranscriptEvents = vi.fn(async () => ({
      available: true,
      events: [
        { type: "message", message: { role: "user", content: "Keep the rollout staged" } },
        {
          type: "message",
          message: { role: "assistant", content: "The next step is the canary" },
        },
      ],
      truncated: false,
    }));
    const harness = registerTestSessionSummaries({ cfg, readBoundedTranscriptEvents });
    const beforePromptBuild = harness.hooks.get("before_prompt_build") as BeforePromptBuildHook;

    // Predecessor is enqueued but its summary has not generated yet (pending).
    const enqueued = await harness.service.repository.enqueue({
      agentId: "main",
      sessionId: "previous",
      sessionKey: "agent:main:main",
      nextSessionId: "current",
      endedAt: Date.now(),
      messageCount: 3,
    });

    // The empty new session gets a provisional tail while the summary is pending.
    const tail = await beforePromptBuild(
      { prompt: "continue", messages: [] },
      { agentId: "main", sessionId: "current", sessionKey: "agent:main:main" },
    );
    expect(tail?.prependContext).toContain("previous_session_tail");
    expect(tail?.prependContext).toContain("Keep the rollout staged");
    await expect(harness.injectionStore.entries()).resolves.toMatchObject([
      { value: { kind: "provisional" } },
    ]);

    // The formal summary finishes generating.
    await completeQueuedSummary(harness.service, enqueued.key, {
      sessionId: "previous",
      summary: "Formal recap: the canary rollout is the next milestone",
    });

    // A later, now non-empty turn upgrades the tail to the formal summary.
    const upgraded = await beforePromptBuild(
      { prompt: "continue", messages: [{ role: "user", content: "resume" }] },
      { agentId: "main", sessionId: "current", sessionKey: "agent:main:main" },
    );
    expect(upgraded?.prependContext).toContain("previous_session_summary");
    expect(upgraded?.prependContext).toContain("Formal recap");
    expect(upgraded?.prependContext).not.toContain("previous_session_tail");
    await expect(harness.injectionStore.entries()).resolves.toMatchObject([
      { value: { kind: "final" } },
    ]);

    // The finalized summary injection is terminal: no further reinjection.
    await expect(
      beforePromptBuild(
        { prompt: "continue", messages: [{ role: "user", content: "resume" }] },
        { agentId: "main", sessionId: "current", sessionKey: "agent:main:main" },
      ),
    ).resolves.toBeUndefined();
  });

  it("re-injects continuity on a native-session rebuild after the transcript-free session grows", async () => {
    const cfg = {
      agents: { list: [{ id: "main", default: true }] },
      plugins: {
        entries: {
          "memory-core": {
            config: {
              summaries: {
                enabled: true,
                autoInject: true,
                lookbackDays: 30,
                maxPromptTokens: 4_000,
                minMessages: 2,
              },
            },
          },
        },
      },
    } satisfies OpenClawConfig;
    const harness = registerTestSessionSummaries({ cfg });
    const beforePromptBuild = harness.hooks.get("before_prompt_build") as BeforePromptBuildHook;

    // Seed a completed predecessor summary.
    const enqueued = await harness.service.repository.enqueue({
      agentId: "main",
      sessionId: "previous",
      sessionKey: "agent:main:main",
      nextSessionId: "current",
      endedAt: Date.now(),
      messageCount: 3,
    });
    await completeQueuedSummary(harness.service, enqueued.key, {
      sessionId: "previous",
      summary: "Durable recap: staged rollout, canary next",
    });

    // First turn seeds the native session with the formal summary.
    const first = await beforePromptBuild(
      { prompt: "continue", messages: [] },
      {
        agentId: "main",
        sessionId: "current",
        sessionKey: "agent:main:main",
        nativeSessionRebuild: true,
      },
    );
    expect(first?.prependContext).toContain("previous_session_summary");
    expect(first?.prependContext).toContain("Durable recap");
    await expect(harness.injectionStore.entries()).resolves.toMatchObject([
      { value: { kind: "final" } },
    ]);

    // A normal reused turn must not re-inject once the session is non-empty.
    await expect(
      beforePromptBuild(
        { prompt: "continue", messages: [{ role: "user", content: "resume" }] },
        { agentId: "main", sessionId: "current", sessionKey: "agent:main:main" },
      ),
    ).resolves.toBeUndefined();

    // A reseed rebuilds the native session from the continuity-free transcript,
    // so it must re-supply the summary even though the session is non-empty and
    // already recorded as injected.
    const reseed = await beforePromptBuild(
      { prompt: "continue", messages: [{ role: "user", content: "resume" }] },
      {
        agentId: "main",
        sessionId: "current",
        sessionKey: "agent:main:main",
        nativeSessionRebuild: true,
      },
    );
    expect(reseed?.prependContext).toContain("previous_session_summary");
    expect(reseed?.prependContext).toContain("Durable recap");
  });

  it("holds a tail upgrade until the direct predecessor settles instead of closing on an ancestor", async () => {
    const cfg = {
      agents: { list: [{ id: "main", default: true }] },
      plugins: {
        entries: {
          "memory-core": {
            config: {
              summaries: {
                enabled: true,
                autoInject: true,
                lookbackDays: 30,
                maxPromptTokens: 4_000,
                minMessages: 2,
              },
            },
          },
        },
      },
    } satisfies OpenClawConfig;
    const readBoundedTranscriptEvents = vi.fn(async () => ({
      available: true,
      events: [{ type: "message", message: { role: "user", content: "direct tail content" } }],
      truncated: false,
    }));
    const harness = registerTestSessionSummaries({ cfg, readBoundedTranscriptEvents });
    const beforePromptBuild = harness.hooks.get("before_prompt_build") as BeforePromptBuildHook;

    // Chain ancestor→previous→current with both summaries still pending.
    const ancestor = await harness.service.repository.enqueue({
      agentId: "main",
      sessionId: "ancestor",
      sessionKey: "agent:main:main",
      nextSessionId: "previous",
      endedAt: Date.now(),
      messageCount: 3,
    });
    const previous = await harness.service.repository.enqueue({
      agentId: "main",
      sessionId: "previous",
      sessionKey: "agent:main:main",
      nextSessionId: "current",
      endedAt: Date.now(),
      messageCount: 3,
    });

    const tail = await beforePromptBuild(
      { prompt: "continue", messages: [] },
      { agentId: "main", sessionId: "current", sessionKey: "agent:main:main" },
    );
    expect(tail?.prependContext).toContain("previous_session_tail");

    // Only the ancestor's summary completes; the direct predecessor is still
    // generating, so the upgrade must wait rather than terminally close on the
    // ancestor's summary alone.
    await completeQueuedSummary(harness.service, ancestor.key, {
      sessionId: "ancestor",
      summary: "Ancestor recap only",
    });
    await expect(
      beforePromptBuild(
        { prompt: "continue", messages: [{ role: "user", content: "resume" }] },
        { agentId: "main", sessionId: "current", sessionKey: "agent:main:main" },
      ),
    ).resolves.toBeUndefined();
    await expect(harness.injectionStore.entries()).resolves.toMatchObject([
      { value: { kind: "provisional" } },
    ]);

    await completeQueuedSummary(harness.service, previous.key, {
      sessionId: "previous",
      summary: "Direct predecessor recap",
    });
    const upgraded = await beforePromptBuild(
      { prompt: "continue", messages: [{ role: "user", content: "resume" }] },
      { agentId: "main", sessionId: "current", sessionKey: "agent:main:main" },
    );
    expect(upgraded?.prependContext).toContain("Direct predecessor recap");
    expect(upgraded?.prependContext).toContain("Ancestor recap only");
    await expect(harness.injectionStore.entries()).resolves.toMatchObject([
      { value: { kind: "final" } },
    ]);
  });

  it("upgrades a provisional injection after an overnight idle gap", async () => {
    const cfg = {
      agents: { list: [{ id: "main", default: true }] },
      plugins: {
        entries: {
          "memory-core": {
            config: {
              summaries: {
                enabled: true,
                autoInject: true,
                lookbackDays: 30,
                maxPromptTokens: 4_000,
                minMessages: 2,
              },
            },
          },
        },
      },
    } satisfies OpenClawConfig;
    let clock = Date.now();
    const readBoundedTranscriptEvents = vi.fn(async () => ({
      available: true,
      events: [{ type: "message", message: { role: "user", content: "overnight tail content" } }],
      truncated: false,
    }));
    const harness = registerTestSessionSummaries({
      cfg,
      now: () => clock,
      readBoundedTranscriptEvents,
    });
    const beforePromptBuild = harness.hooks.get("before_prompt_build") as BeforePromptBuildHook;
    const enqueued = await harness.service.repository.enqueue({
      agentId: "main",
      sessionId: "previous",
      sessionKey: "agent:main:main",
      nextSessionId: "current",
      endedAt: clock,
      messageCount: 3,
    });

    const tail = await beforePromptBuild(
      { prompt: "continue", messages: [] },
      { agentId: "main", sessionId: "current", sessionKey: "agent:main:main" },
    );
    expect(tail?.prependContext).toContain("previous_session_tail");

    // The summary completes shortly after, but the user only returns hours
    // later; elapsed wall time must not forfeit the upgrade.
    await completeQueuedSummary(harness.service, enqueued.key, {
      sessionId: "previous",
      summary: "Overnight recap",
    });
    clock += 11 * 60 * 60 * 1000;
    const upgraded = await beforePromptBuild(
      { prompt: "continue", messages: [{ role: "user", content: "resume" }] },
      { agentId: "main", sessionId: "current", sessionKey: "agent:main:main" },
    );
    expect(upgraded?.prependContext).toContain("Overnight recap");
    await expect(harness.injectionStore.entries()).resolves.toMatchObject([
      { value: { kind: "final" } },
    ]);
  });

  it("keeps an ancestor-only chain injection provisional until the direct predecessor completes", async () => {
    const cfg = {
      agents: { list: [{ id: "main", default: true }] },
      plugins: {
        entries: {
          "memory-core": {
            config: {
              summaries: {
                enabled: true,
                autoInject: true,
                lookbackDays: 30,
                maxPromptTokens: 4_000,
                minMessages: 2,
              },
            },
          },
        },
      },
    } satisfies OpenClawConfig;
    const harness = registerTestSessionSummaries({ cfg });
    const beforePromptBuild = harness.hooks.get("before_prompt_build") as BeforePromptBuildHook;

    // The ancestor's summary is already complete; the direct predecessor's is
    // still generating when the new session starts.
    const ancestor = await harness.service.repository.enqueue({
      agentId: "main",
      sessionId: "ancestor",
      sessionKey: "agent:main:main",
      nextSessionId: "previous",
      endedAt: Date.now(),
      messageCount: 3,
    });
    await completeQueuedSummary(harness.service, ancestor.key, {
      sessionId: "ancestor",
      summary: "Ancestor recap",
    });
    const previous = await harness.service.repository.enqueue({
      agentId: "main",
      sessionId: "previous",
      sessionKey: "agent:main:main",
      nextSessionId: "current",
      endedAt: Date.now(),
      messageCount: 3,
    });

    const first = await beforePromptBuild(
      { prompt: "continue", messages: [] },
      { agentId: "main", sessionId: "current", sessionKey: "agent:main:main" },
    );
    expect(first?.prependContext).toContain("Ancestor recap");
    await expect(harness.injectionStore.entries()).resolves.toMatchObject([
      { value: { kind: "provisional" } },
    ]);

    await completeQueuedSummary(harness.service, previous.key, {
      sessionId: "previous",
      summary: "Direct predecessor recap",
    });
    const upgraded = await beforePromptBuild(
      { prompt: "continue", messages: [{ role: "user", content: "resume" }] },
      { agentId: "main", sessionId: "current", sessionKey: "agent:main:main" },
    );
    expect(upgraded?.prependContext).toContain("Direct predecessor recap");
    await expect(harness.injectionStore.entries()).resolves.toMatchObject([
      { value: { kind: "final" } },
    ]);
  });

  it("closes the upgrade watch once the predecessor summary terminally fails", async () => {
    const cfg = {
      agents: { list: [{ id: "main", default: true }] },
      plugins: {
        entries: {
          "memory-core": {
            config: {
              summaries: {
                enabled: true,
                autoInject: true,
                lookbackDays: 30,
                maxPromptTokens: 4_000,
                minMessages: 2,
              },
            },
          },
        },
      },
    } satisfies OpenClawConfig;
    const readBoundedTranscriptEvents = vi.fn(async () => ({
      available: true,
      events: [{ type: "message", message: { role: "user", content: "doomed tail content" } }],
      truncated: false,
    }));
    const harness = registerTestSessionSummaries({ cfg, readBoundedTranscriptEvents });
    const beforePromptBuild = harness.hooks.get("before_prompt_build") as BeforePromptBuildHook;
    const enqueued = await harness.service.repository.enqueue({
      agentId: "main",
      sessionId: "previous",
      sessionKey: "agent:main:main",
      nextSessionId: "current",
      endedAt: Date.now(),
      messageCount: 3,
    });

    const tail = await beforePromptBuild(
      { prompt: "continue", messages: [] },
      { agentId: "main", sessionId: "current", sessionKey: "agent:main:main" },
    );
    expect(tail?.prependContext).toContain("previous_session_tail");

    const claimed = await harness.service.repository.claim(enqueued.key);
    if (!claimed) {
      throw new Error("expected failed predecessor claim");
    }
    await harness.service.repository.markFailed(
      enqueued.key,
      "generation exploded",
      Date.now(),
      claimed.revision,
      { retryable: false },
    );

    // Observing the terminal failure finalizes the record so later turns skip
    // the repository entirely.
    await expect(
      beforePromptBuild(
        { prompt: "continue", messages: [{ role: "user", content: "resume" }] },
        { agentId: "main", sessionId: "current", sessionKey: "agent:main:main" },
      ),
    ).resolves.toBeUndefined();
    await expect(harness.injectionStore.entries()).resolves.toMatchObject([
      { value: { kind: "final" } },
    ]);
    const predecessorSpy = vi.spyOn(harness.service.repository, "findDirectPredecessor");
    await expect(
      beforePromptBuild(
        { prompt: "continue", messages: [{ role: "user", content: "resume" }] },
        { agentId: "main", sessionId: "current", sessionKey: "agent:main:main" },
      ),
    ).resolves.toBeUndefined();
    expect(predecessorSpy).not.toHaveBeenCalled();
  });

  it.each([
    { label: "terminal", retryable: false },
    { label: "retryable", retryable: true },
  ])(
    "does not inject a predecessor tail during a $label summary failure",
    async ({ retryable }) => {
      const cfg = {
        agents: { list: [{ id: "main", default: true }] },
        plugins: {
          entries: {
            "memory-core": {
              config: {
                summaries: {
                  enabled: true,
                  autoInject: true,
                  lookbackDays: 30,
                  maxPromptTokens: 4_000,
                  minMessages: 2,
                },
              },
            },
          },
        },
      } satisfies OpenClawConfig;
      const readBoundedTranscriptEvents = vi.fn(async () => ({
        available: true,
        events: [{ type: "message", message: { role: "user", content: "private tail" } }],
        truncated: false,
      }));
      const harness = registerTestSessionSummaries({ cfg, readBoundedTranscriptEvents });
      const enqueued = await harness.service.repository.enqueue({
        agentId: "main",
        sessionId: "failed-predecessor",
        sessionKey: "agent:main:main",
        nextSessionId: "current",
        endedAt: Date.now(),
        messageCount: 2,
      });
      const claimed = await harness.service.repository.claim(enqueued.key);
      if (!claimed) {
        throw new Error("expected failed predecessor claim");
      }
      await harness.service.repository.markFailed(
        enqueued.key,
        "summary generation failed",
        Date.now(),
        claimed.revision,
        { retryable },
      );

      const beforePromptBuild = harness.hooks.get("before_prompt_build") as BeforePromptBuildHook;
      expect(
        await beforePromptBuild(
          { prompt: "continue", messages: [] },
          { agentId: "main", sessionId: "current", sessionKey: "agent:main:main" },
        ),
      ).toBeUndefined();
      expect(readBoundedTranscriptEvents).not.toHaveBeenCalled();
    },
  );

  it("filters non-terminal reasons and uses the target-agent fallback without LLM override trust", async () => {
    const cfg = {
      agents: { list: [{ id: "main", default: true }] },
      plugins: {
        entries: {
          "memory-core": {
            config: {
              summaries: {
                enabled: true,
                autoInject: false,
                lookbackDays: 30,
                maxPromptTokens: 4_000,
                minMessages: 2,
              },
            },
          },
        },
      },
    } satisfies OpenClawConfig;
    const complete = vi.fn(
      async (_params: Parameters<OpenClawPluginApi["runtime"]["llm"]["complete"]>[0]) =>
        createCompletionResult("Default summary"),
    );
    const harness = registerTestSessionSummaries({ cfg, complete });
    const sessionEnd = harness.hooks.get("session_end") as SessionEndHook;
    const ignoredReasons = ["compaction", "unknown", "shutdown", "restart"] as const;
    for (const reason of ignoredReasons) {
      await sessionEnd(
        { sessionId: `ignored-${reason}`, messageCount: 2, reason },
        { agentId: "main", sessionId: `ignored-${reason}`, sessionKey: "agent:main:main" },
      );
    }
    expect(await harness.service.repository.readAllRecords()).toEqual([]);

    await sessionEnd(
      { sessionId: "normal-reset", messageCount: 2, reason: "reset" },
      { agentId: "main", sessionId: "normal-reset", sessionKey: "agent:main:main" },
    );
    await harness.service.waitForIdle();

    expect(complete).toHaveBeenCalledTimes(1);
    expect(complete.mock.calls[0]?.[0]).not.toHaveProperty("agentId");
    expect(complete.mock.calls[0]?.[0]).not.toHaveProperty("model");
    expect(typeof harness.registeredService()?.stop).toBe("function");
    await harness.registeredService()?.stop?.({} as never);
  });

  it("passes the fixed Sonnet summary model through the trusted LLM override seam", async () => {
    const cfg = {
      agents: { list: [{ id: "main", default: true }] },
      plugins: {
        entries: {
          "memory-core": {
            llm: { allowModelOverride: true },
            config: {
              summaries: {
                enabled: true,
                autoInject: false,
                lookbackDays: 30,
                maxPromptTokens: 4_000,
                minMessages: 2,
              },
            },
          },
        },
      },
    } satisfies OpenClawConfig;
    const complete = vi.fn(
      async (_params: Parameters<OpenClawPluginApi["runtime"]["llm"]["complete"]>[0]) =>
        createCompletionResult("Fixed-model summary"),
    );
    const harness = registerTestSessionSummaries({ cfg, complete });
    const sessionEnd = harness.hooks.get("session_end") as SessionEndHook;

    await sessionEnd(
      { sessionId: "fixed-model", messageCount: 2, reason: "reset" },
      { agentId: "main", sessionId: "fixed-model", sessionKey: "agent:main:main" },
    );
    await harness.service.waitForIdle();

    expect(complete).toHaveBeenCalledTimes(1);
    expect(complete.mock.calls[0]?.[0]).toMatchObject({
      model: "anthropic/claude-sonnet-4-6",
    });
  });

  it("generates one or all historical summaries with dry-run, skip, and force semantics", async () => {
    const cfg = {
      agents: { list: [{ id: "main", default: true }] },
      plugins: {
        entries: {
          "memory-core": {
            llm: { allowModelOverride: true },
            config: {
              summaries: {
                enabled: true,
                autoInject: false,
                lookbackDays: 30,
                maxPromptTokens: 4_000,
                minMessages: 2,
              },
            },
          },
        },
      },
    } satisfies OpenClawConfig;
    const candidates = [
      {
        sessionId: "11111111-1111-4111-8111-111111111111",
        sessionKey: "agent:main:main",
        sessionFile: "/private/session-one.jsonl",
        nextSessionId: "22222222-2222-4222-8222-222222222222",
        endedAt: 100,
      },
      {
        sessionId: "22222222-2222-4222-8222-222222222222",
        sessionKey: "agent:main:main",
        sessionFile: "/private/session-two.jsonl",
        endedAt: 200,
      },
    ];
    const resolveBackfillCandidates = vi.fn(
      (params: { agentId: string; requestedSessionId?: string }) =>
        candidates.filter(
          (candidate) =>
            !params.requestedSessionId || candidate.sessionId === params.requestedSessionId,
        ),
    );
    const complete = vi.fn(
      async (_params: Parameters<OpenClawPluginApi["runtime"]["llm"]["complete"]>[0]) =>
        createCompletionResult("Generated historical summary"),
    );
    const harness = registerTestSessionSummaries({
      cfg,
      complete,
      resolveBackfillCandidates,
    });
    const generate = harness.gatewayHandlers.get("memory.summaries.generate");
    if (!generate) {
      throw new Error("expected memory.summaries.generate gateway method");
    }
    const firstSessionId = candidates[0].sessionId;
    const respond = vi.fn();

    await generate({ params: {}, respond });
    expect(respond).toHaveBeenLastCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "invalid_request" }),
    );

    respond.mockClear();
    await generate({ params: { sessionId: firstSessionId, dryRun: true }, respond });
    expect(respond).toHaveBeenLastCalledWith(
      true,
      expect.objectContaining({ evaluated: 1, planned: 1, dryRun: true }),
    );
    expect(complete).not.toHaveBeenCalled();

    respond.mockClear();
    await generate({ params: { sessionId: firstSessionId }, respond });
    expect(respond).toHaveBeenLastCalledWith(
      true,
      expect.objectContaining({ evaluated: 1, planned: 1, dryRun: false }),
    );
    expect(complete).toHaveBeenCalledTimes(1);
    expect(complete.mock.calls[0]?.[0]).toMatchObject({
      model: "anthropic/claude-sonnet-4-6",
    });
    const generatedPayload = respond.mock.calls[0]?.[1] as {
      items?: Array<Record<string, unknown>>;
    };
    expect(generatedPayload.items?.[0]).not.toHaveProperty("sessionFile");

    respond.mockClear();
    await generate({ params: { sessionId: firstSessionId }, respond });
    expect(respond).toHaveBeenLastCalledWith(
      true,
      expect.objectContaining({ planned: 0, skippedExisting: 1 }),
    );
    expect(complete).toHaveBeenCalledTimes(1);

    respond.mockClear();
    await generate({ params: { sessionId: firstSessionId, force: true }, respond });
    expect(respond).toHaveBeenLastCalledWith(
      true,
      expect.objectContaining({ planned: 1, force: true }),
    );
    expect(complete).toHaveBeenCalledTimes(2);

    respond.mockClear();
    await generate({ params: { all: true, agentId: "MAIN" }, respond });
    expect(respond).toHaveBeenLastCalledWith(
      true,
      expect.objectContaining({ agentId: "main", evaluated: 2, planned: 1 }),
    );
    expect(complete).toHaveBeenCalledTimes(3);
    expect(resolveBackfillCandidates).toHaveBeenLastCalledWith({
      agentId: "main",
      cfg,
    });

    respond.mockClear();
    await generate({ params: { all: true, agentId: "../escape" }, respond });
    expect(respond).toHaveBeenLastCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "invalid_request" }),
    );
  });

  it("requires explicit trust for non-default agents and model overrides", async () => {
    const makeConfig = (params: {
      allowAgentIdOverride?: boolean;
      allowModelOverride?: boolean;
      model?: string;
    }) =>
      ({
        agents: {
          list: [{ id: "main", default: true }, { id: "other" }],
        },
        plugins: {
          entries: {
            "memory-core": {
              llm: {
                ...(params.allowAgentIdOverride !== undefined
                  ? { allowAgentIdOverride: params.allowAgentIdOverride }
                  : {}),
                ...(params.allowModelOverride !== undefined
                  ? { allowModelOverride: params.allowModelOverride }
                  : {}),
              },
              config: {
                summaries: {
                  enabled: true,
                  autoInject: false,
                  lookbackDays: 30,
                  maxPromptTokens: 4_000,
                  minMessages: 2,
                  ...(params.model ? { model: params.model } : {}),
                },
              },
            },
          },
        },
      }) satisfies OpenClawConfig;

    const deniedAgent = registerTestSessionSummaries({ cfg: makeConfig({}) });
    const deniedAgentEnd = deniedAgent.hooks.get("session_end") as SessionEndHook;
    await deniedAgentEnd(
      { sessionId: "other-denied", messageCount: 2, reason: "reset" },
      { agentId: "other", sessionId: "other-denied", sessionKey: "agent:other:main" },
    );
    await deniedAgent.service.waitForIdle();
    expect(await deniedAgent.service.repository.readAllRecords()).toEqual([]);
    expect(deniedAgent.readBoundedTranscriptEvents).not.toHaveBeenCalled();
    expect(deniedAgent.complete).not.toHaveBeenCalled();
    await deniedAgent.service.stop();

    const allowedAgentComplete = vi.fn(
      async (_params: Parameters<OpenClawPluginApi["runtime"]["llm"]["complete"]>[0]) =>
        createCompletionResult("Other summary", "other"),
    );
    const allowedAgent = registerTestSessionSummaries({
      cfg: makeConfig({ allowAgentIdOverride: true }),
      complete: allowedAgentComplete,
    });
    const allowedAgentEnd = allowedAgent.hooks.get("session_end") as SessionEndHook;
    await allowedAgentEnd(
      { sessionId: "other-allowed", messageCount: 2, reason: "reset" },
      { agentId: "other", sessionId: "other-allowed", sessionKey: "agent:other:main" },
    );
    await allowedAgent.service.waitForIdle();
    expect(allowedAgentComplete.mock.calls[0]?.[0]).toMatchObject({ agentId: "other" });

    const deniedModel = registerTestSessionSummaries({
      cfg: makeConfig({ model: "openai/gpt-5.4-mini" }),
    });
    const deniedModelEnd = deniedModel.hooks.get("session_end") as SessionEndHook;
    await deniedModelEnd(
      { sessionId: "model-denied", messageCount: 2, reason: "reset" },
      { agentId: "main", sessionId: "model-denied", sessionKey: "agent:main:main" },
    );
    await deniedModel.service.waitForIdle();
    expect(await deniedModel.service.repository.readAllRecords()).toEqual([]);
    expect(deniedModel.readBoundedTranscriptEvents).not.toHaveBeenCalled();
    expect(deniedModel.complete).not.toHaveBeenCalled();
    await deniedModel.service.stop();
  });
});
