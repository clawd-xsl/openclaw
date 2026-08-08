import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  captureAgentRunLifecycleGeneration,
  getAgentEventLifecycleGeneration,
  withAgentRunLifecycleGeneration,
} from "./agent-events.js";
import {
  enqueueSystemEvent,
  enqueueSystemEventEntry,
  enqueueSystemEventEntryWithStatus,
  peekSystemEventEntries,
  resetSystemEventsForTest,
} from "./system-events.js";

const runtimeMocks = vi.hoisted(() => ({
  dispatchInboundMessageWithDispatcher: vi.fn(),
  extractDeliveryInfo: vi.fn(),
  getRuntimeConfig: vi.fn(),
  inferOutboundTargetChatType: vi.fn(),
}));

vi.mock("./system-event-turn.runtime.js", () => runtimeMocks);

const { requestSystemEventTurn, runSystemEventTurn } = await import("./system-event-turn.js");

type SystemEventTurnModule = typeof import("./system-event-turn.js");

const systemEventTurnModuleUrl = new URL("./system-event-turn.ts", import.meta.url).href;

async function importSystemEventTurnModule(cacheBust: string): Promise<SystemEventTurnModule> {
  return (await import(`${systemEventTurnModuleUrl}?t=${cacheBust}`)) as SystemEventTurnModule;
}

type MockDispatchParams = {
  ctx: {
    Body?: string;
    Provider?: string;
    Surface?: string;
    SessionKey?: string;
    TranscriptBody?: string;
    From?: string;
    SenderId?: string;
    To?: string;
  };
  replyOptions?: {
    onAgentRunStart?: (runId: string) => void;
    onUserMessagePersisted?: () => void;
  };
};

function enqueueTurnEvent(
  text: string,
  options: Omit<Parameters<typeof enqueueSystemEvent>[1], "consumer">,
) {
  return enqueueSystemEvent(text, { ...options, consumer: "system-event-turn" });
}

function successfulDispatchResult() {
  return {
    queuedFinal: true,
    counts: { tool: 0, block: 1, final: 1 },
  };
}

describe("system event turn", () => {
  beforeEach(() => {
    resetSystemEventsForTest();
    vi.clearAllMocks();
    runtimeMocks.getRuntimeConfig.mockReturnValue({});
    runtimeMocks.extractDeliveryInfo.mockReturnValue({
      deliveryContext: undefined,
      threadId: undefined,
    });
    runtimeMocks.inferOutboundTargetChatType.mockReturnValue("direct");
    runtimeMocks.dispatchInboundMessageWithDispatcher.mockResolvedValue(successfulDispatchResult());
  });

  it("routes pending events through an explicit event delivery context", async () => {
    const sessionKey = "agent:main:cron:test:run:1";
    enqueueTurnEvent("Send the reminder", {
      sessionKey,
      deliveryContext: {
        channel: "signal",
        to: "signal-target",
        accountId: "default",
      },
      senderId: "signal-owner",
      inputProvenance: {
        kind: "inter_session",
        sourceSessionKey: "agent:main:hook:gmail:test",
        sourceTool: "sessions_send",
      },
      sourceAuthority: { kind: "owner" },
    });

    const result = await runSystemEventTurn({ sessionKey, reason: "cron:test" });

    expect(result).toEqual({
      status: "ran",
      eventCount: 1,
      hasDeliveryTarget: true,
      counts: { tool: 0, block: 1, final: 1 },
    });
    expect(runtimeMocks.extractDeliveryInfo).toHaveBeenCalledWith(sessionKey, { cfg: {} });
    expect(runtimeMocks.dispatchInboundMessageWithDispatcher).toHaveBeenCalledWith(
      expect.objectContaining({
        ctx: expect.objectContaining({
          Provider: "system-event",
          SessionKey: sessionKey,
          OriginatingChannel: "signal",
          OriginatingTo: "signal-target",
          AccountId: "default",
          InputProvenance: {
            kind: "inter_session",
            sourceSessionKey: "agent:main:hook:gmail:test",
            sourceTool: "sessions_send",
          },
          CommandAuthorized: true,
          ChatType: "direct",
          Body: expect.stringContaining("Event: ["),
          TranscriptBody: "Send the reminder",
          ExplicitDeliverRoute: true,
          SuppressMessageReceivedHooks: true,
        }),
        replyOptions: expect.objectContaining({
          isHeartbeat: false,
          suppressSystemEventDrain: true,
          typingPolicy: "system_event",
        }),
      }),
    );
    const dispatch = runtimeMocks.dispatchInboundMessageWithDispatcher.mock.calls[0]?.[0] as
      | MockDispatchParams
      | undefined;
    expect(dispatch?.ctx).not.toHaveProperty("Surface");
    expect(dispatch?.ctx).not.toHaveProperty("GatewayClientScopes");
    expect(dispatch?.ctx).not.toHaveProperty("From");
    expect(dispatch?.ctx).not.toHaveProperty("SenderId");
    expect(dispatch?.ctx.Body).toContain("[Inter-session message]");
    expect(dispatch?.ctx.TranscriptBody).not.toContain("[Inter-session message]");
  });

  it("keeps the generic transcript marker for system events without provenance", async () => {
    const sessionKey = "agent:main:main";
    enqueueTurnEvent("Generic wake", { sessionKey });

    await runSystemEventTurn({ sessionKey, reason: "generic:wake" });

    const dispatch = runtimeMocks.dispatchInboundMessageWithDispatcher.mock.calls[0]?.[0] as
      | MockDispatchParams
      | undefined;
    expect(dispatch?.ctx.TranscriptBody).toBe("[OpenClaw system event]");
  });

  it("does not infer authority for a provenance-bearing event from its delivery route", async () => {
    const sessionKey = "agent:main:main";
    enqueueTurnEvent("Untrusted handoff", {
      sessionKey,
      deliveryContext: { channel: "signal", to: "signal-target" },
      senderId: "signal-owner",
      inputProvenance: {
        kind: "inter_session",
        sourceSessionKey: "agent:main:hook:gmail:untrusted",
        sourceTool: "sessions_send",
      },
    });

    await runSystemEventTurn({ sessionKey, reason: "sessions_send:hook" });

    const dispatch = runtimeMocks.dispatchInboundMessageWithDispatcher.mock.calls[0]?.[0] as
      | MockDispatchParams
      | undefined;
    expect(dispatch?.ctx).toEqual(
      expect.objectContaining({
        Provider: "system-event",
        OriginatingChannel: "signal",
        OriginatingTo: "signal-target",
        CommandAuthorized: false,
      }),
    );
    expect(dispatch?.ctx).not.toHaveProperty("GatewayClientScopes");
    expect(dispatch?.ctx).not.toHaveProperty("From");
    expect(dispatch?.ctx).not.toHaveProperty("SenderId");
  });

  it("does not batch sessions_send handoffs with unrelated system events", async () => {
    const sessionKey = "agent:main:main";
    const deliveryContext = { channel: "signal", to: "owner-uuid" };
    enqueueTurnEvent("Gmail handoff", {
      sessionKey,
      deliveryContext,
      inputProvenance: {
        kind: "inter_session",
        sourceSessionKey: "agent:main:hook:gmail:test",
        sourceTool: "sessions_send",
      },
    });
    enqueueTurnEvent("Unrelated wake", { sessionKey, deliveryContext });

    await runSystemEventTurn({ sessionKey, reason: "hook:wake" });

    const firstDispatch = runtimeMocks.dispatchInboundMessageWithDispatcher.mock.calls[0]?.[0] as
      | MockDispatchParams
      | undefined;
    expect(firstDispatch?.ctx.Body).toContain("Gmail handoff");
    expect(firstDispatch?.ctx.Body).not.toContain("Unrelated wake");
    expect(peekSystemEventEntries(sessionKey).map((event) => event.text)).toEqual([
      "Unrelated wake",
    ]);
  });

  it("runs the requested handoff instead of acknowledging an older queued event", async () => {
    const sessionKey = "agent:main:main";
    const deliveryContext = { channel: "signal", to: "owner-uuid" };
    enqueueTurnEvent("Older unrelated wake", { sessionKey, deliveryContext });
    const handoff = enqueueSystemEventEntry("Requested Gmail handoff", {
      sessionKey,
      deliveryContext,
      consumer: "system-event-turn",
      inputProvenance: {
        kind: "inter_session",
        sourceSessionKey: "agent:main:hook:gmail:requested",
        sourceTool: "sessions_send",
      },
    });
    expect(handoff).not.toBeNull();

    await runSystemEventTurn({
      sessionKey,
      reason: "sessions_send:hook",
      requestedEvents: handoff ? [handoff] : [],
    });

    const dispatch = runtimeMocks.dispatchInboundMessageWithDispatcher.mock.calls[0]?.[0] as
      | MockDispatchParams
      | undefined;
    expect(dispatch?.ctx.Body).toContain("Requested Gmail handoff");
    expect(dispatch?.ctx.Body).not.toContain("Older unrelated wake");
    expect(peekSystemEventEntries(sessionKey).map((event) => event.text)).toEqual([
      "Older unrelated wake",
    ]);
  });

  it("serializes direct requested turns with other attempts for the same session", async () => {
    const sessionKey = "agent:main:main";
    const first = enqueueSystemEventEntry("First handoff", {
      sessionKey,
      consumer: "system-event-turn",
      inputProvenance: {
        kind: "inter_session",
        sourceSessionKey: "agent:main:hook:gmail:first",
        sourceTool: "sessions_send",
      },
    });
    const second = enqueueSystemEventEntry("Second handoff", {
      sessionKey,
      consumer: "system-event-turn",
      inputProvenance: {
        kind: "inter_session",
        sourceSessionKey: "agent:main:hook:gmail:second",
        sourceTool: "sessions_send",
      },
    });
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();

    let releaseFirst: () => void = () => undefined;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    runtimeMocks.dispatchInboundMessageWithDispatcher
      .mockImplementationOnce(async () => {
        await firstBlocked;
        return successfulDispatchResult();
      })
      .mockResolvedValueOnce(successfulDispatchResult());

    const firstRun = runSystemEventTurn({
      sessionKey,
      requestedEvents: first ? [first] : [],
    });
    await vi.waitFor(() => {
      expect(runtimeMocks.dispatchInboundMessageWithDispatcher).toHaveBeenCalledTimes(1);
    });
    expect(peekSystemEventEntries(sessionKey).map((event) => event.text)).not.toContain(
      "First handoff",
    );
    const secondRun = runSystemEventTurn({
      sessionKey,
      requestedEvents: second ? [second] : [],
    });
    await Promise.resolve();
    expect(runtimeMocks.dispatchInboundMessageWithDispatcher).toHaveBeenCalledTimes(1);

    releaseFirst();
    await Promise.all([firstRun, secondRun]);

    expect(runtimeMocks.dispatchInboundMessageWithDispatcher).toHaveBeenCalledTimes(2);
    const secondDispatch = runtimeMocks.dispatchInboundMessageWithDispatcher.mock.calls[1]?.[0] as
      | MockDispatchParams
      | undefined;
    expect(secondDispatch?.ctx.Body).toContain("Second handoff");
    expect(peekSystemEventEntries(sessionKey)).toEqual([]);
  });

  it("shares atomic claims across duplicate turn module instances", async () => {
    const sessionKey = "agent:main:main";
    const firstModule = await importSystemEventTurnModule(`claim-first-${Date.now()}`);
    const secondModule = await importSystemEventTurnModule(`claim-second-${Date.now()}`);
    enqueueTurnEvent("Single retained handoff", { sessionKey });
    let releaseFirst: () => void = () => undefined;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    runtimeMocks.dispatchInboundMessageWithDispatcher.mockImplementationOnce(async () => {
      await firstBlocked;
      return successfulDispatchResult();
    });

    const firstRun = firstModule.runSystemEventTurn({ sessionKey });
    await vi.waitFor(() => {
      expect(runtimeMocks.dispatchInboundMessageWithDispatcher).toHaveBeenCalledTimes(1);
    });
    const secondRun = secondModule.runSystemEventTurn({ sessionKey });
    await Promise.resolve();
    expect(runtimeMocks.dispatchInboundMessageWithDispatcher).toHaveBeenCalledTimes(1);

    releaseFirst();
    await firstRun;
    await expect(secondRun).resolves.toEqual({
      status: "skipped",
      reason: "no-events",
    });
    expect(runtimeMocks.dispatchInboundMessageWithDispatcher).toHaveBeenCalledTimes(1);
    expect(peekSystemEventEntries(sessionKey)).toEqual([]);
  });

  it("serializes distinct events across duplicate turn module instances", async () => {
    const sessionKey = "agent:main:main";
    const firstModule = await importSystemEventTurnModule(`tail-first-${Date.now()}`);
    const secondModule = await importSystemEventTurnModule(`tail-second-${Date.now()}`);
    const first = enqueueSystemEventEntry("First retained handoff", {
      sessionKey,
      consumer: "system-event-turn",
      inputProvenance: {
        kind: "inter_session",
        sourceSessionKey: "agent:main:hook:gmail:first-module",
        sourceTool: "sessions_send",
      },
    });
    const second = enqueueSystemEventEntry("Second retained handoff", {
      sessionKey,
      consumer: "system-event-turn",
      inputProvenance: {
        kind: "inter_session",
        sourceSessionKey: "agent:main:hook:gmail:second-module",
        sourceTool: "sessions_send",
      },
    });
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();

    let releaseFirst: () => void = () => undefined;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    runtimeMocks.dispatchInboundMessageWithDispatcher
      .mockImplementationOnce(async () => {
        await firstBlocked;
        return successfulDispatchResult();
      })
      .mockResolvedValueOnce(successfulDispatchResult());

    const firstRun = firstModule.runSystemEventTurn({
      sessionKey,
      requestedEvents: first ? [first] : [],
    });
    await vi.waitFor(() => {
      expect(runtimeMocks.dispatchInboundMessageWithDispatcher).toHaveBeenCalledTimes(1);
    });
    const secondRun = secondModule.runSystemEventTurn({
      sessionKey,
      requestedEvents: second ? [second] : [],
    });
    await Promise.resolve();
    expect(runtimeMocks.dispatchInboundMessageWithDispatcher).toHaveBeenCalledTimes(1);

    releaseFirst();
    await Promise.all([firstRun, secondRun]);
    expect(runtimeMocks.dispatchInboundMessageWithDispatcher).toHaveBeenCalledTimes(2);
    expect(peekSystemEventEntries(sessionKey)).toEqual([]);
  });

  it("admits queued turns under the current gateway lifecycle", async () => {
    const sessionKey = "agent:main:main";
    enqueueTurnEvent("Lifecycle-owned handoff", { sessionKey });
    let observedLifecycleGeneration: string | undefined;
    runtimeMocks.dispatchInboundMessageWithDispatcher.mockImplementationOnce(async () => {
      observedLifecycleGeneration = captureAgentRunLifecycleGeneration("system-event-test-run");
      return successfulDispatchResult();
    });

    await withAgentRunLifecycleGeneration("retired-hook-generation", () =>
      runSystemEventTurn({ sessionKey, reason: "hook:lifecycle" }),
    );

    expect(observedLifecycleGeneration).toBe(getAgentEventLifecycleGeneration());
    expect(observedLifecycleGeneration).not.toBe("retired-hook-generation");
  });

  it("keeps an in-flight claim reserved against queue capacity", async () => {
    const sessionKey = "agent:main:main";
    enqueueTurnEvent("Blocking handoff", { sessionKey });
    let releaseTurn: () => void = () => undefined;
    const blocked = new Promise<void>((resolve) => {
      releaseTurn = resolve;
    });
    runtimeMocks.dispatchInboundMessageWithDispatcher.mockImplementationOnce(async () => {
      await blocked;
      return successfulDispatchResult();
    });

    const run = runSystemEventTurn({ sessionKey });
    await vi.waitFor(() => {
      expect(runtimeMocks.dispatchInboundMessageWithDispatcher).toHaveBeenCalledTimes(1);
    });
    for (let index = 0; index < 19; index += 1) {
      expect(
        enqueueSystemEventEntryWithStatus(`Queued handoff ${index}`, {
          sessionKey,
          consumer: "system-event-turn",
        }).status,
      ).toBe("enqueued");
    }
    expect(
      enqueueSystemEventEntryWithStatus("Queue overflow", {
        sessionKey,
        consumer: "system-event-turn",
      }),
    ).toEqual({ status: "skipped", reason: "full" });

    releaseTurn();
    await run;
    expect(
      enqueueSystemEventEntryWithStatus("Admitted after completion", {
        sessionKey,
        consumer: "system-event-turn",
      }).status,
    ).toBe("enqueued");
  });

  it("honors abort while preserving queue order and the unclaimed requested event", async () => {
    const sessionKey = "agent:main:main";
    const first = enqueueSystemEventEntry("Blocking handoff", {
      sessionKey,
      consumer: "system-event-turn",
    });
    const timedOut = enqueueSystemEventEntry("Timed out handoff", {
      sessionKey,
      consumer: "system-event-turn",
      inputProvenance: {
        kind: "inter_session",
        sourceSessionKey: "agent:main:hook:gmail:timeout",
        sourceTool: "sessions_send",
      },
    });
    expect(first).not.toBeNull();
    expect(timedOut).not.toBeNull();

    let releaseFirst: () => void = () => undefined;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    runtimeMocks.dispatchInboundMessageWithDispatcher
      .mockImplementationOnce(async () => {
        await firstBlocked;
        return successfulDispatchResult();
      })
      .mockResolvedValueOnce(successfulDispatchResult());

    const firstRun = runSystemEventTurn({
      sessionKey,
      requestedEvents: first ? [first] : [],
    });
    await vi.waitFor(() => {
      expect(runtimeMocks.dispatchInboundMessageWithDispatcher).toHaveBeenCalledTimes(1);
    });
    const abortController = new AbortController();
    const timedOutRun = runSystemEventTurn({
      sessionKey,
      abortSignal: abortController.signal,
      requestedEvents: timedOut ? [timedOut] : [],
    });
    abortController.abort(new Error("queue wait timed out"));

    await expect(timedOutRun).rejects.toThrow("queue wait timed out");
    expect(runtimeMocks.dispatchInboundMessageWithDispatcher).toHaveBeenCalledTimes(1);
    expect(peekSystemEventEntries(sessionKey).map((event) => event.text)).toContain(
      "Timed out handoff",
    );

    releaseFirst();
    await firstRun;
    await runSystemEventTurn({
      sessionKey,
      requestedEvents: timedOut ? [timedOut] : [],
    });

    expect(runtimeMocks.dispatchInboundMessageWithDispatcher).toHaveBeenCalledTimes(2);
    const retryDispatch = runtimeMocks.dispatchInboundMessageWithDispatcher.mock.calls[1]?.[0] as
      | MockDispatchParams
      | undefined;
    expect(retryDispatch?.ctx.Body).toContain("Timed out handoff");
    expect(peekSystemEventEntries(sessionKey)).toEqual([]);
  });

  it("preserves the owner sender when a hook event omits the account id", async () => {
    // Regression: a wake/hook event route "signal:<uuid>" with no accountId must
    // still match the persisted session route (accountId=default) so the owner
    // sender — and its owner-only tools — survive.
    const sessionKey = "agent:main:main";
    enqueueTurnEvent("Process the wake", {
      sessionKey,
      deliveryContext: { channel: "signal", to: "owner-uuid" },
    });
    runtimeMocks.extractDeliveryInfo.mockReturnValue({
      deliveryContext: { channel: "signal", to: "owner-uuid", accountId: "default" },
      threadId: undefined,
      senderId: "signal-owner",
    });

    await runSystemEventTurn({ sessionKey, reason: "hook:wake" });

    const dispatch = runtimeMocks.dispatchInboundMessageWithDispatcher.mock.calls[0]?.[0] as
      | MockDispatchParams
      | undefined;
    expect(dispatch?.ctx).toEqual(
      expect.objectContaining({
        AccountId: "default",
        SenderId: "signal-owner",
        From: "signal-owner",
      }),
    );
  });

  it("falls back to the persisted session delivery route", async () => {
    const sessionKey = "agent:main:main";
    enqueueTurnEvent("Process the wake", { sessionKey });
    runtimeMocks.extractDeliveryInfo.mockReturnValue({
      deliveryContext: { channel: "signal", to: "stored-target" },
      threadId: undefined,
      chatType: "group",
      senderId: "signal-owner",
    });
    runtimeMocks.inferOutboundTargetChatType.mockReturnValueOnce(undefined);

    await runSystemEventTurn({ sessionKey, reason: "hook:wake" });

    expect(runtimeMocks.extractDeliveryInfo).toHaveBeenCalledWith(sessionKey, { cfg: {} });
    expect(runtimeMocks.dispatchInboundMessageWithDispatcher).toHaveBeenCalledWith(
      expect.objectContaining({
        ctx: expect.objectContaining({
          OriginatingChannel: "signal",
          OriginatingTo: "stored-target",
          ChatType: "group",
          From: "signal-owner",
          SenderId: "signal-owner",
          To: "stored-target",
        }),
      }),
    );
    expect(runtimeMocks.inferOutboundTargetChatType).not.toHaveBeenCalled();
  });

  it("prefers the canonical session-key thread over a stale stored thread", async () => {
    const sessionKey = "agent:main:telegram:group:family:topic:canonical-thread";
    enqueueTurnEvent("Process the topic wake", { sessionKey });
    runtimeMocks.extractDeliveryInfo.mockReturnValue({
      deliveryContext: {
        channel: "telegram",
        to: "group:family",
        threadId: "stale-thread",
      },
      threadId: "canonical-thread",
      chatType: "group",
      senderId: "telegram-owner",
    });

    await runSystemEventTurn({ sessionKey, reason: "hook:topic-wake" });

    expect(runtimeMocks.dispatchInboundMessageWithDispatcher).toHaveBeenCalledWith(
      expect.objectContaining({
        ctx: expect.objectContaining({
          OriginatingChannel: "telegram",
          OriginatingTo: "group:family",
          MessageThreadId: "canonical-thread",
        }),
      }),
    );
  });

  it("does not reuse a persisted sender across an explicit channel boundary", async () => {
    const sessionKey = "agent:main:main";
    enqueueTurnEvent("Route this elsewhere", {
      sessionKey,
      deliveryContext: { channel: "signal", to: "signal-target" },
    });
    runtimeMocks.extractDeliveryInfo.mockReturnValue({
      deliveryContext: { channel: "slack", to: "channel:C1", accountId: "work" },
      threadId: undefined,
      chatType: "group",
      senderId: "slack:U123",
    });

    await runSystemEventTurn({ sessionKey, reason: "hook:cross-channel" });

    const dispatch = runtimeMocks.dispatchInboundMessageWithDispatcher.mock.calls[0]?.[0] as
      | MockDispatchParams
      | undefined;
    expect(dispatch?.ctx).toEqual(
      expect.objectContaining({
        OriginatingChannel: "signal",
        OriginatingTo: "signal-target",
        To: "signal-target",
      }),
    );
    expect(dispatch?.ctx).not.toHaveProperty("From");
    expect(dispatch?.ctx).not.toHaveProperty("SenderId");
  });

  it.each([
    {
      name: "target",
      fallback: { channel: "slack", to: "channel:C1", accountId: "work" },
      explicit: { channel: "slack", to: "channel:C2", accountId: "work" },
    },
    {
      name: "thread",
      fallback: {
        channel: "slack",
        to: "channel:C1",
        accountId: "work",
        threadId: "thread-1",
      },
      explicit: {
        channel: "slack",
        to: "channel:C1",
        accountId: "work",
        threadId: "thread-2",
      },
    },
  ])("does not reuse a persisted sender across an explicit $name boundary", async (testCase) => {
    const sessionKey = "agent:main:main";
    enqueueTurnEvent("Route this within Slack", {
      sessionKey,
      deliveryContext: testCase.explicit,
    });
    runtimeMocks.extractDeliveryInfo.mockReturnValue({
      deliveryContext: testCase.fallback,
      threadId: undefined,
      chatType: "channel",
      senderId: "slack:U123",
    });

    await runSystemEventTurn({ sessionKey, reason: `hook:cross-${testCase.name}` });

    const dispatch = runtimeMocks.dispatchInboundMessageWithDispatcher.mock.calls[0]?.[0] as
      | MockDispatchParams
      | undefined;
    expect(dispatch?.ctx).toEqual(
      expect.objectContaining({
        OriginatingChannel: "slack",
        OriginatingTo: testCase.explicit.to,
        To: testCase.explicit.to,
      }),
    );
    expect(dispatch?.ctx).not.toHaveProperty("From");
    expect(dispatch?.ctx).not.toHaveProperty("SenderId");
  });

  it("skips a turn when an earlier turn already drained the queue", async () => {
    const result = await runSystemEventTurn({
      sessionKey: "agent:main:main",
      reason: "hook:wake",
    });

    expect(result).toEqual({ status: "skipped", reason: "no-events" });
    expect(runtimeMocks.dispatchInboundMessageWithDispatcher).not.toHaveBeenCalled();
  });

  it("leaves events owned by the heartbeat path queued", async () => {
    const sessionKey = "agent:main:main";
    enqueueSystemEvent("Process this on the next heartbeat", { sessionKey });

    const result = await runSystemEventTurn({ sessionKey, reason: "hook:wake" });

    expect(result).toEqual({ status: "skipped", reason: "no-events" });
    expect(runtimeMocks.dispatchInboundMessageWithDispatcher).not.toHaveBeenCalled();
    expect(peekSystemEventEntries(sessionKey).map((event) => event.text)).toEqual([
      "Process this on the next heartbeat",
    ]);
  });

  it("restores drained events when dispatch throws", async () => {
    const sessionKey = "agent:main:main";
    enqueueTurnEvent("Retry this event", {
      sessionKey,
      contextKey: "hook:test",
      deliveryContext: { channel: "signal", to: "signal-target" },
    });
    runtimeMocks.dispatchInboundMessageWithDispatcher.mockImplementationOnce(async () => {
      throw new Error("dispatch failed");
    });

    await expect(runSystemEventTurn({ sessionKey, reason: "hook:test" })).rejects.toThrow(
      "dispatch failed",
    );

    expect(peekSystemEventEntries(sessionKey)).toEqual([
      expect.objectContaining({
        text: "Retry this event",
        contextKey: "hook:test",
        deliveryContext: { channel: "signal", to: "signal-target" },
      }),
    ]);
  });

  it("does not restore a settled turn when abort arrives after dispatch", async () => {
    const sessionKey = "agent:main:main";
    const abortController = new AbortController();
    enqueueTurnEvent("Deliver exactly once", {
      sessionKey,
      deliveryContext: { channel: "signal", to: "signal-target" },
    });
    runtimeMocks.dispatchInboundMessageWithDispatcher.mockImplementationOnce(async () => {
      abortController.abort();
      return successfulDispatchResult();
    });

    await expect(
      runSystemEventTurn({
        sessionKey,
        reason: "hook:late-abort",
        abortSignal: abortController.signal,
      }),
    ).resolves.toMatchObject({ status: "ran", eventCount: 1 });

    expect(peekSystemEventEntries(sessionKey)).toEqual([]);
  });

  it("restores claimed events when outbound chat-type inference throws", async () => {
    const sessionKey = "agent:main:main";
    enqueueTurnEvent("Retry route inference", {
      sessionKey,
      deliveryContext: { channel: "signal", to: "malformed-target" },
    });
    runtimeMocks.inferOutboundTargetChatType.mockImplementationOnce(() => {
      throw new Error("target parser failed");
    });

    await expect(runSystemEventTurn({ sessionKey, reason: "hook:inference" })).rejects.toThrow(
      "target parser failed",
    );

    expect(peekSystemEventEntries(sessionKey)).toEqual([
      expect.objectContaining({ text: "Retry route inference" }),
    ]);
  });

  it("restores a claimed event when the run starts but fails before transcript persistence", async () => {
    const sessionKey = "agent:main:main";
    enqueueTurnEvent("Unpersisted handoff", { sessionKey });
    runtimeMocks.dispatchInboundMessageWithDispatcher.mockImplementationOnce(async (params) => {
      (params as MockDispatchParams).replyOptions?.onAgentRunStart?.("run-started");
      throw new Error("startup failure");
    });

    await expect(runSystemEventTurn({ sessionKey, reason: "hook:startup" })).rejects.toThrow(
      "startup failure",
    );
    expect(peekSystemEventEntries(sessionKey)).toEqual([
      expect.objectContaining({ text: "Unpersisted handoff" }),
    ]);
  });

  it("does not replay a claimed event after its user turn is persisted", async () => {
    const sessionKey = "agent:main:main";
    enqueueTurnEvent("Adopted handoff", { sessionKey });
    runtimeMocks.dispatchInboundMessageWithDispatcher.mockImplementationOnce(async (params) => {
      (params as MockDispatchParams).replyOptions?.onUserMessagePersisted?.();
      throw new Error("post-adoption failure");
    });

    await expect(runSystemEventTurn({ sessionKey, reason: "hook:adopted" })).rejects.toThrow(
      "post-adoption failure",
    );
    expect(peekSystemEventEntries(sessionKey)).toEqual([]);
    await expect(runSystemEventTurn({ sessionKey, reason: "hook:retry" })).resolves.toEqual({
      status: "skipped",
      reason: "no-events",
    });
    expect(runtimeMocks.dispatchInboundMessageWithDispatcher).toHaveBeenCalledTimes(1);
  });

  it.each([{ failedCounts: { tool: 0, block: 0, final: 1 } }])(
    "commits the turn without replay when delivery reports failure",
    async (failure) => {
      const sessionKey = "agent:main:main";
      enqueueTurnEvent("Retry failed delivery", {
        sessionKey,
        deliveryContext: { channel: "signal", to: "signal-target" },
      });
      runtimeMocks.dispatchInboundMessageWithDispatcher.mockResolvedValueOnce({
        ...successfulDispatchResult(),
        ...failure,
      });

      await expect(runSystemEventTurn({ sessionKey, reason: "hook:test" })).resolves.toMatchObject({
        status: "ran",
        failedCounts: failure.failedCounts,
      });
      expect(peekSystemEventEntries(sessionKey)).toEqual([]);
      await expect(runSystemEventTurn({ sessionKey, reason: "hook:retry" })).resolves.toEqual({
        status: "skipped",
        reason: "no-events",
      });
      expect(runtimeMocks.dispatchInboundMessageWithDispatcher).toHaveBeenCalledTimes(1);
    },
  );

  it("processes explicit delivery routes in separate turns", async () => {
    const sessionKey = "agent:main:main";
    enqueueTurnEvent("First recipient", {
      sessionKey,
      deliveryContext: { channel: "signal", to: "recipient-a" },
    });
    enqueueTurnEvent("Second recipient", {
      sessionKey,
      deliveryContext: { channel: "signal", to: "recipient-b" },
    });

    await runSystemEventTurn({ sessionKey, reason: "hook:first" });

    const firstCall = runtimeMocks.dispatchInboundMessageWithDispatcher.mock.calls[0]?.[0] as
      | MockDispatchParams
      | undefined;
    expect(firstCall?.ctx).toEqual(
      expect.objectContaining({ OriginatingChannel: "signal", OriginatingTo: "recipient-a" }),
    );
    expect(firstCall?.ctx.Body).toContain("First recipient");
    expect(firstCall?.ctx.Body).not.toContain("Second recipient");
    expect(peekSystemEventEntries(sessionKey).map((event) => event.text)).toEqual([
      "Second recipient",
    ]);

    await runSystemEventTurn({ sessionKey, reason: "hook:second" });

    const secondCall = runtimeMocks.dispatchInboundMessageWithDispatcher.mock.calls[1]?.[0] as
      | MockDispatchParams
      | undefined;
    expect(secondCall?.ctx).toEqual(
      expect.objectContaining({ OriginatingChannel: "signal", OriginatingTo: "recipient-b" }),
    );
    expect(peekSystemEventEntries(sessionKey)).toEqual([]);
  });

  it("processes turn-owned events even when their text resembles an exec completion", async () => {
    const sessionKey = "agent:main:main";
    enqueueTurnEvent("Exec finished: deploy", {
      sessionKey,
      deliveryContext: { channel: "signal", to: "recipient" },
    });

    const result = await runSystemEventTurn({ sessionKey, reason: "hook:exec-shaped" });

    expect(result).toMatchObject({ status: "ran", eventCount: 1 });
    expect(runtimeMocks.dispatchInboundMessageWithDispatcher).toHaveBeenCalledTimes(1);
    const dispatch = runtimeMocks.dispatchInboundMessageWithDispatcher.mock.calls[0]?.[0] as
      | MockDispatchParams
      | undefined;
    expect(dispatch?.ctx.Body).toContain("Exec finished: deploy");
    expect(peekSystemEventEntries(sessionKey)).toEqual([]);
  });

  it("passes heartbeat-shaped turn-owned text to the agent without compacting it away", async () => {
    const sessionKey = "agent:main:main";
    enqueueTurnEvent("Read HEARTBEAT.md and report status", {
      sessionKey,
      deliveryContext: { channel: "signal", to: "recipient" },
    });

    await runSystemEventTurn({ sessionKey, reason: "hook:heartbeat-shaped" });

    const dispatch = runtimeMocks.dispatchInboundMessageWithDispatcher.mock.calls[0]?.[0] as
      | MockDispatchParams
      | undefined;
    expect(dispatch?.ctx.Body).toContain("Read HEARTBEAT.md and report status");
    expect(peekSystemEventEntries(sessionKey)).toEqual([]);
  });

  it("retries an asynchronous wake after a transient dispatch failure", async () => {
    const sessionKey = "agent:main:main";
    enqueueTurnEvent("Retry asynchronously", {
      sessionKey,
      deliveryContext: { channel: "signal", to: "recipient" },
    });
    runtimeMocks.dispatchInboundMessageWithDispatcher
      .mockImplementationOnce(async () => {
        throw new Error("temporary failure");
      })
      .mockResolvedValueOnce(successfulDispatchResult());

    requestSystemEventTurn({ sessionKey, reason: "hook:retry", coalesceMs: 0 });

    await vi.waitFor(
      () => {
        expect(runtimeMocks.dispatchInboundMessageWithDispatcher).toHaveBeenCalledTimes(2);
        expect(peekSystemEventEntries(sessionKey)).toEqual([]);
      },
      { timeout: 3_000 },
    );
  });

  it("does not retry an asynchronous wake after transcript persistence", async () => {
    const sessionKey = "agent:main:main";
    enqueueTurnEvent("Committed asynchronous handoff", {
      sessionKey,
      deliveryContext: { channel: "signal", to: "recipient" },
    });
    runtimeMocks.dispatchInboundMessageWithDispatcher.mockImplementationOnce(async (params) => {
      (params as MockDispatchParams).replyOptions?.onUserMessagePersisted?.();
      throw new Error("failure after persistence");
    });

    requestSystemEventTurn({ sessionKey, reason: "hook:committed", coalesceMs: 0 });

    await vi.waitFor(() => {
      expect(runtimeMocks.dispatchInboundMessageWithDispatcher).toHaveBeenCalledTimes(1);
      expect(peekSystemEventEntries(sessionKey)).toEqual([]);
    });
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    expect(runtimeMocks.dispatchInboundMessageWithDispatcher).toHaveBeenCalledTimes(1);
  });

  it("drops an exhausted batch while processing a coalesced event on the same route", async () => {
    const sessionKey = "agent:main:main";
    enqueueTurnEvent("Permanently failing event", {
      sessionKey,
      deliveryContext: { channel: "signal", to: "recipient" },
    });
    let failedAttempts = 0;
    runtimeMocks.dispatchInboundMessageWithDispatcher.mockImplementation(async (value) => {
      const dispatch = value as MockDispatchParams;
      if (dispatch.ctx.Body?.includes("Permanently failing event")) {
        failedAttempts += 1;
        if (failedAttempts === 1) {
          enqueueTurnEvent("Later coalesced event", {
            sessionKey,
            deliveryContext: { channel: "signal", to: "recipient" },
          });
          requestSystemEventTurn({ sessionKey, reason: "hook:later", coalesceMs: 0 });
        }
        throw new Error("permanent failure");
      }
      return successfulDispatchResult();
    });

    requestSystemEventTurn({ sessionKey, reason: "hook:first", coalesceMs: 0 });

    await vi.waitFor(
      () => {
        expect(failedAttempts).toBe(4);
        expect(runtimeMocks.dispatchInboundMessageWithDispatcher).toHaveBeenCalledTimes(5);
        expect(peekSystemEventEntries(sessionKey)).toEqual([]);
      },
      { timeout: 15_000 },
    );
    const finalDispatch = runtimeMocks.dispatchInboundMessageWithDispatcher.mock.calls[4]?.[0] as
      | MockDispatchParams
      | undefined;
    expect(finalDispatch?.ctx.Body).toContain("Later coalesced event");
    expect(finalDispatch?.ctx.Body).not.toContain("Permanently failing event");
  });
});
