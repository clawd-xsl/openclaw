import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  enqueueSystemEvent,
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
          From: "signal-owner",
          SenderId: "signal-owner",
          ChatType: "direct",
          Body: expect.stringContaining("Event: ["),
          TranscriptBody: "[OpenClaw system event]",
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

  it.each([{ failedCounts: { tool: 0, block: 0, final: 1 } }])(
    "restores consumed events when delivery reports failure",
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

      await expect(runSystemEventTurn({ sessionKey, reason: "hook:test" })).rejects.toThrow(
        "system event reply delivery failed",
      );

      expect(peekSystemEventEntries(sessionKey)).toEqual([
        expect.objectContaining({
          text: "Retry failed delivery",
          consumer: "system-event-turn",
        }),
      ]);
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
