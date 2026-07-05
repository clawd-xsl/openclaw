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
  ctx: { agentId?: string; sessionId?: string; sessionKey?: string },
) => Promise<{ prependContext?: string } | void> | { prependContext?: string } | void;

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
  readBoundedTranscriptEvents?: NonNullable<
    RegisterSessionSummariesOptions["readBoundedTranscriptEvents"]
  >;
}) {
  const hooks = new Map<string, unknown>();
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
    state: { openKeyedStore: vi.fn() },
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
    registerService(service) {
      registeredService = service;
    },
  });
  const service = registerSessionSummaries(api, {
    predecessorIndexStore,
    readBoundedTranscriptEvents,
    summaryStore,
  });
  return {
    complete,
    hooks,
    predecessorIndexStore,
    readBoundedTranscriptEvents,
    registeredService: () => registeredService,
    service,
    summaryStore,
  };
}

describe("session summaries plugin registration", () => {
  it("injects only a visible direct predecessor and exposes scoped tool/RPC reads", async () => {
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
      state: { openKeyedStore: () => store },
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

    const now = Date.now();
    await seed({
      sessionId: "previous",
      sessionKey: "agent:main:main",
      nextSessionId: "current",
      summary: `Migration reached 95%. ${"bounded detail ".repeat(500)}`,
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
    const injection = await beforePromptBuild(
      { prompt: "continue", messages: [] },
      { agentId: "main", sessionId: "current", sessionKey: "agent:main:main" },
    );
    expect(injection?.prependContext).toContain("previous_session_summary");
    expect(injection?.prependContext).toContain("Migration reached 95%");
    expect(injection?.prependContext).not.toContain("This must not be injected");
    expect(estimateSessionSummaryTokens(injection?.prependContext ?? "")).toBeLessThanOrEqual(
      1_200,
    );
    expect(entriesSpy).not.toHaveBeenCalled();

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
    await gatewayHandler?.({ params: { agentId: "main", limit: 2 }, respond });
    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        items: expect.arrayContaining([
          expect.objectContaining({ agentId: "main", sessionId: "not-direct" }),
        ]),
      }),
    );
    const rpcPayload = respond.mock.calls[0]?.[1] as { items?: unknown[] } | undefined;
    expect(rpcPayload?.items).toHaveLength(2);

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

  it("filters non-terminal session reasons and strips the default agent id from runtime LLM calls", async () => {
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
    expect(typeof harness.registeredService()?.stop).toBe("function");
    await harness.registeredService()?.stop?.({} as never);
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
