import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DeliveryContext } from "../utils/delivery-context.types.js";

const mocks = vi.hoisted(() => ({
  getReplyFromConfig: vi.fn(),
  routeReply: vi.fn(async () => ({ ok: true, messageId: "msg-1" })),
  loadConfig: vi.fn(() => ({})),
  resolveMainSessionKeyFromConfig: vi.fn(() => "agent:main:main"),
  extractDeliveryInfo: vi.fn((): { deliveryContext?: DeliveryContext; threadId?: string } => ({
    deliveryContext: undefined,
    threadId: undefined,
  })),
  enqueueCommandInLane: vi.fn(async (_lane: unknown, fn: () => Promise<void>) => {
    await fn();
  }),
  getQueueSize: vi.fn(() => 1),
}));

describe("requestHookAgentTurn", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    mocks.getReplyFromConfig.mockReset();
    mocks.routeReply.mockReset().mockResolvedValue({ ok: true, messageId: "msg-1" });
    mocks.loadConfig.mockReset().mockReturnValue({});
    mocks.resolveMainSessionKeyFromConfig.mockReset().mockReturnValue("agent:main:main");
    mocks.extractDeliveryInfo.mockReset().mockReturnValue({
      deliveryContext: undefined,
      threadId: undefined,
    });
    mocks.enqueueCommandInLane.mockClear();
    mocks.getQueueSize.mockReset().mockReturnValue(1);
  });

  afterEach(async () => {
    const { resetSystemEventsForTest } = await import("./system-events.js");
    resetSystemEventsForTest();
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it("routes synthetic wake replies to the queued event delivery target", async () => {
    vi.doMock("../auto-reply/reply.js", () => ({
      getReplyFromConfig: mocks.getReplyFromConfig,
    }));
    vi.doMock("../auto-reply/reply/route-reply.js", () => ({
      routeReply: mocks.routeReply,
    }));
    vi.doMock("../config/config.js", () => ({
      loadConfig: mocks.loadConfig,
    }));
    vi.doMock("../config/sessions.js", () => ({
      resolveMainSessionKeyFromConfig: mocks.resolveMainSessionKeyFromConfig,
    }));
    vi.doMock("../config/sessions/delivery-info.js", () => ({
      extractDeliveryInfo: mocks.extractDeliveryInfo,
    }));
    vi.doMock("../process/command-queue.js", () => ({
      enqueueCommandInLane: mocks.enqueueCommandInLane,
      getQueueSize: mocks.getQueueSize,
    }));

    const { enqueueSystemEvent } = await import("./system-events.js");
    const { requestHookAgentTurn } = await import("./hook-agent-turn.js");

    mocks.getReplyFromConfig.mockResolvedValueOnce({ text: "Fidelity alert" });
    enqueueSystemEvent("Hook Outlook: Fidelity alert", {
      sessionKey: "agent:main:main",
      trusted: false,
      deliveryContext: {
        channel: "signal",
        to: "signal-chat",
        accountId: "default",
        threadId: "42",
      },
    });

    requestHookAgentTurn({ reason: "hook:test", coalesceMs: 0 });
    await vi.runAllTimersAsync();

    expect(mocks.getReplyFromConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        Provider: "hook-event",
        SessionKey: "agent:main:main",
        OriginatingChannel: "signal",
        OriginatingTo: "signal-chat",
        MessageThreadId: "42",
      }),
      { isHeartbeat: false },
      {},
    );
    expect(mocks.routeReply).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: { text: "Fidelity alert" },
        channel: "signal",
        to: "signal-chat",
        accountId: "default",
        threadId: "42",
        sessionKey: "agent:main:main",
      }),
    );
  });

  it("falls back to stored session delivery info when queued events have no route", async () => {
    vi.doMock("../auto-reply/reply.js", () => ({
      getReplyFromConfig: mocks.getReplyFromConfig,
    }));
    vi.doMock("../auto-reply/reply/route-reply.js", () => ({
      routeReply: mocks.routeReply,
    }));
    vi.doMock("../config/config.js", () => ({
      loadConfig: mocks.loadConfig,
    }));
    vi.doMock("../config/sessions.js", () => ({
      resolveMainSessionKeyFromConfig: mocks.resolveMainSessionKeyFromConfig,
    }));
    vi.doMock("../config/sessions/delivery-info.js", () => ({
      extractDeliveryInfo: mocks.extractDeliveryInfo,
    }));
    vi.doMock("../process/command-queue.js", () => ({
      enqueueCommandInLane: mocks.enqueueCommandInLane,
      getQueueSize: mocks.getQueueSize,
    }));

    const { enqueueSystemEvent } = await import("./system-events.js");
    const { requestHookAgentTurn } = await import("./hook-agent-turn.js");

    mocks.getReplyFromConfig.mockResolvedValueOnce([{ text: "One" }, { text: "Two" }]);
    mocks.extractDeliveryInfo.mockReturnValueOnce({
      deliveryContext: {
        channel: "telegram",
        to: "telegram:123",
        accountId: "acct-1",
        threadId: "7",
      },
      threadId: "7",
    });
    enqueueSystemEvent("Hook Gmail: pending", {
      sessionKey: "agent:main:main",
      trusted: false,
    });

    requestHookAgentTurn({ reason: "hook:test-fallback", coalesceMs: 0 });
    await vi.runAllTimersAsync();

    expect(mocks.routeReply).toHaveBeenCalledTimes(2);
    expect(mocks.routeReply).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        payload: { text: "One" },
        channel: "telegram",
        to: "telegram:123",
      }),
    );
    expect(mocks.routeReply).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        payload: { text: "Two" },
        channel: "telegram",
        to: "telegram:123",
      }),
    );
  });

  it("runs the synthetic turn for an explicit session key", async () => {
    vi.doMock("../auto-reply/reply.js", () => ({
      getReplyFromConfig: mocks.getReplyFromConfig,
    }));
    vi.doMock("../auto-reply/reply/route-reply.js", () => ({
      routeReply: mocks.routeReply,
    }));
    vi.doMock("../config/config.js", () => ({
      loadConfig: mocks.loadConfig,
    }));
    vi.doMock("../config/sessions.js", () => ({
      resolveMainSessionKeyFromConfig: mocks.resolveMainSessionKeyFromConfig,
    }));
    vi.doMock("../config/sessions/delivery-info.js", () => ({
      extractDeliveryInfo: mocks.extractDeliveryInfo,
    }));
    vi.doMock("../process/command-queue.js", () => ({
      enqueueCommandInLane: mocks.enqueueCommandInLane,
      getQueueSize: mocks.getQueueSize,
    }));

    const { enqueueSystemEvent } = await import("./system-events.js");
    const { requestHookAgentTurn } = await import("./hook-agent-turn.js");

    mocks.getReplyFromConfig.mockResolvedValueOnce(undefined);
    enqueueSystemEvent("Cron reminder", {
      sessionKey: "agent:main:telegram:direct:123",
    });

    requestHookAgentTurn({
      reason: "cron:reminder",
      sessionKey: "agent:main:telegram:direct:123",
      coalesceMs: 0,
    });
    await vi.runAllTimersAsync();

    expect(mocks.resolveMainSessionKeyFromConfig).not.toHaveBeenCalled();
    expect(mocks.getReplyFromConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        Provider: "hook-event",
        SessionKey: "agent:main:telegram:direct:123",
      }),
      { isHeartbeat: false },
      {},
    );
  });
});
