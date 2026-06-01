import type { MsgContext } from "openclaw/plugin-sdk/reply-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { expectChannelInboundContextContract as expectInboundContextContract } from "../../../../src/channels/plugins/contracts/test-helpers.js";
vi.useRealTimers();
const [
  { createBaseSignalEventHandlerDeps, createSignalReceiveEvent },
  { createSignalEventHandler },
] = await Promise.all([import("./event-handler.test-harness.js"), import("./event-handler.js")]);

const { sendTypingMock, sendReadReceiptMock, dispatchInboundMessageMock, capture } = vi.hoisted(
  () => {
    const captureState: { ctx?: MsgContext } = {};
    return {
      sendTypingMock: vi.fn(),
      sendReadReceiptMock: vi.fn(),
      dispatchInboundMessageMock: vi.fn(
        async (params: {
          ctx: MsgContext;
          replyOptions?: {
            abortSignal?: AbortSignal;
            onReplyStart?: () => void | Promise<void>;
          };
        }) => {
          captureState.ctx = params.ctx;
          await Promise.resolve(params.replyOptions?.onReplyStart?.());
          return { queuedFinal: false, counts: { tool: 0, block: 0, final: 0 } };
        },
      ),
      capture: captureState,
    };
  },
);

vi.mock("../send.js", () => ({
  sendMessageSignal: vi.fn(),
  sendTypingSignal: sendTypingMock,
  sendReadReceiptSignal: sendReadReceiptMock,
}));

vi.mock("../../../../src/auto-reply/dispatch.js", async () => {
  const actual = await vi.importActual<typeof import("../../../../src/auto-reply/dispatch.js")>(
    "../../../../src/auto-reply/dispatch.js",
  );
  return {
    ...actual,
    dispatchInboundMessage: dispatchInboundMessageMock,
    dispatchInboundMessageWithDispatcher: dispatchInboundMessageMock,
    dispatchInboundMessageWithBufferedDispatcher: dispatchInboundMessageMock,
  };
});

vi.mock("../../../../src/pairing/pairing-store.js", () => ({
  readChannelAllowFromStore: vi.fn().mockResolvedValue([]),
  upsertChannelPairingRequest: vi.fn(),
}));

describe("signal createSignalEventHandler inbound context", () => {
  beforeEach(() => {
    delete capture.ctx;
    sendTypingMock.mockReset().mockResolvedValue(true);
    sendReadReceiptMock.mockReset().mockResolvedValue(true);
    dispatchInboundMessageMock.mockClear();
  });

  it("passes a finalized MsgContext to dispatchInboundMessage", async () => {
    const handler = createSignalEventHandler(
      createBaseSignalEventHandlerDeps({
        cfg: { messages: { inbound: { debounceMs: 0 } } } as any,
        historyLimit: 0,
      }),
    );

    await handler(
      createSignalReceiveEvent({
        dataMessage: {
          message: "hi",
          attachments: [],
          groupInfo: { groupId: "g1", groupName: "Test Group" },
        },
      }),
    );

    expect(capture.ctx).toBeTruthy();
    const contextWithBody = capture.ctx;
    if (!contextWithBody) {
      throw new Error("expected inbound MsgContext");
    }
    expectInboundContextContract(contextWithBody);
    // Sender should appear as prefix in group messages (no redundant [from:] suffix)
    expect(String(contextWithBody.Body ?? "")).toContain("Alice");
    expect(String(contextWithBody.Body ?? "")).toMatch(/Alice.*:/);
    expect(String(contextWithBody.Body ?? "")).not.toContain("[from:");
  });

  it("normalizes direct chat To/OriginatingTo targets to canonical Signal ids", async () => {
    const handler = createSignalEventHandler(
      createBaseSignalEventHandlerDeps({
        cfg: { messages: { inbound: { debounceMs: 0 } } } as any,
        historyLimit: 0,
      }),
    );

    await handler(
      createSignalReceiveEvent({
        sourceNumber: "+15550002222",
        sourceName: "Bob",
        timestamp: 1700000000001,
        dataMessage: {
          message: "hello",
          attachments: [],
        },
      }),
    );

    expect(capture.ctx).toBeTruthy();
    const context = capture.ctx!;
    expect(context.ChatType).toBe("direct");
    expect(context.To).toBe("+15550002222");
    expect(context.OriginatingTo).toBe("+15550002222");
  });

  it("sends typing + read receipt for allowed DMs", async () => {
    const handler = createSignalEventHandler(
      createBaseSignalEventHandlerDeps({
        cfg: {
          messages: { inbound: { debounceMs: 0 } },
          channels: { signal: { dmPolicy: "open", allowFrom: ["*"] } },
        },
        account: "+15550009999",
        blockStreaming: false,
        historyLimit: 0,
        groupHistories: new Map(),
        sendReadReceipts: true,
      }),
    );

    await handler(
      createSignalReceiveEvent({
        dataMessage: {
          message: "hi",
        },
      }),
    );

    expect(sendTypingMock).toHaveBeenCalledWith("+15550001111", expect.any(Object));
    expect(sendReadReceiptMock).toHaveBeenCalledWith(
      "signal:+15550001111",
      1700000000000,
      expect.any(Object),
    );
  });

  it("starts DM typing before dispatch begins", async () => {
    dispatchInboundMessageMock.mockImplementationOnce(async (params: { ctx: MsgContext }) => {
      capture.ctx = params.ctx;
      expect(sendTypingMock).toHaveBeenCalledTimes(1);
      return { queuedFinal: false, counts: { tool: 0, block: 0, final: 0 } };
    });

    const handler = createSignalEventHandler(
      createBaseSignalEventHandlerDeps({
        cfg: {
          messages: { inbound: { debounceMs: 0 } },
          channels: { signal: { dmPolicy: "open", allowFrom: ["*"] } },
        },
        account: "+15550009999",
        blockStreaming: false,
        historyLimit: 0,
        groupHistories: new Map(),
      }),
    );

    await handler(
      createSignalReceiveEvent({
        dataMessage: {
          message: "ping",
        },
      }),
    );

    expect(sendTypingMock).toHaveBeenCalledTimes(1);
  });

  it("aborts the previous inbound reply signal when a new DM arrives for the same session", async () => {
    let firstAbortSignal: AbortSignal | undefined;
    let firstDispatchStartedResolve: (() => void) | undefined;
    const firstDispatchStarted = new Promise<void>((resolve) => {
      firstDispatchStartedResolve = resolve;
    });

    dispatchInboundMessageMock
      .mockImplementationOnce(
        async (params: { ctx: MsgContext; replyOptions?: { abortSignal?: AbortSignal } }) => {
          capture.ctx = params.ctx;
          firstAbortSignal = params.replyOptions?.abortSignal;
          firstDispatchStartedResolve?.();
          await new Promise<void>((resolve) => {
            params.replyOptions?.abortSignal?.addEventListener("abort", () => resolve(), {
              once: true,
            });
          });
          return { queuedFinal: false, counts: { tool: 0, block: 0, final: 0 } };
        },
      )
      .mockResolvedValueOnce({ queuedFinal: false, counts: { tool: 0, block: 0, final: 0 } });

    const handler = createSignalEventHandler(
      createBaseSignalEventHandlerDeps({
        cfg: {
          messages: { inbound: { debounceMs: 0 } },
          channels: { signal: { dmPolicy: "open", allowFrom: ["*"] } },
        },
        historyLimit: 0,
      }),
    );

    const first = handler(
      createSignalReceiveEvent({
        dataMessage: {
          message: "first",
          attachments: [],
        },
      }),
    );
    await firstDispatchStarted;
    expect(firstAbortSignal?.aborted).toBe(false);

    await handler(
      createSignalReceiveEvent({
        dataMessage: {
          message: "second",
          attachments: [],
        },
      }),
    );

    expect(dispatchInboundMessageMock).toHaveBeenCalledTimes(2);
    expect(firstAbortSignal?.aborted).toBe(true);
    const secondAbortSignal = (
      dispatchInboundMessageMock.mock.calls[1]?.[0] as
        | { replyOptions?: { abortSignal?: AbortSignal } }
        | undefined
    )?.replyOptions?.abortSignal;
    expect(secondAbortSignal).toBeDefined();
    expect(secondAbortSignal).not.toBe(firstAbortSignal);
    expect(secondAbortSignal?.aborted).toBe(false);

    await first;
  });

  it("does not auto-authorize DM commands in open mode without allowlists", async () => {
    const handler = createSignalEventHandler(
      createBaseSignalEventHandlerDeps({
        cfg: {
          messages: { inbound: { debounceMs: 0 } },
          channels: { signal: { dmPolicy: "open", allowFrom: [] } },
        },
        allowFrom: [],
        groupAllowFrom: [],
        account: "+15550009999",
        blockStreaming: false,
        historyLimit: 0,
        groupHistories: new Map(),
      }),
    );

    await handler(
      createSignalReceiveEvent({
        dataMessage: {
          message: "/status",
          attachments: [],
        },
      }),
    );

    expect(capture.ctx).toBeTruthy();
    expect(capture.ctx?.CommandAuthorized).toBe(false);
  });

  it("drops quote-only group context from non-allowlisted quoted senders in allowlist mode", async () => {
    const handler = createSignalEventHandler(
      createBaseSignalEventHandlerDeps({
        cfg: {
          messages: { inbound: { debounceMs: 0 } },
          channels: {
            signal: {
              groupPolicy: "allowlist",
              groupAllowFrom: ["+15550001111"],
              contextVisibility: "allowlist",
            },
          },
        },
        groupPolicy: "allowlist",
        groupAllowFrom: ["+15550001111"],
        historyLimit: 0,
      }),
    );

    await handler(
      createSignalReceiveEvent({
        dataMessage: {
          message: "",
          quote: { text: "blocked quote", author: "+15550002222" },
          groupInfo: { groupId: "g1", groupName: "Test Group" },
          attachments: [],
        },
      }),
    );

    expect(capture.ctx).toBeUndefined();
    expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
  });

  it("keeps quote-only group context in allowlist_quote mode", async () => {
    const handler = createSignalEventHandler(
      createBaseSignalEventHandlerDeps({
        cfg: {
          messages: { inbound: { debounceMs: 0 } },
          channels: {
            signal: {
              groupPolicy: "allowlist",
              groupAllowFrom: ["+15550001111"],
              contextVisibility: "allowlist_quote",
            },
          },
        },
        groupPolicy: "allowlist",
        groupAllowFrom: ["+15550001111"],
        historyLimit: 0,
      }),
    );

    await handler(
      createSignalReceiveEvent({
        dataMessage: {
          message: "",
          quote: { text: "quoted context", author: "+15550002222" },
          groupInfo: { groupId: "g1", groupName: "Test Group" },
          attachments: [],
        },
      }),
    );

    expect(capture.ctx).toBeTruthy();
    expect(capture.ctx?.BodyForAgent).toBe("quoted context");
    expect(capture.ctx?.ReplyToBody).toBe("quoted context");
    expect(capture.ctx?.ReplyToSender).toBe("+15550002222");
    expect(capture.ctx?.ReplyToIsQuote).toBe(true);
  });

  it("preserves visible quote context when a reply includes new text", async () => {
    const handler = createSignalEventHandler(
      createBaseSignalEventHandlerDeps({
        cfg: {
          messages: { inbound: { debounceMs: 0 } },
          channels: {
            signal: {
              groupPolicy: "allowlist",
              groupAllowFrom: ["+15550001111", "+15550002222"],
              contextVisibility: "allowlist_quote",
            },
          },
        },
        groupPolicy: "allowlist",
        groupAllowFrom: ["+15550001111", "+15550002222"],
        historyLimit: 0,
      }),
    );

    await handler(
      createSignalReceiveEvent({
        dataMessage: {
          message: "follow-up",
          quote: { text: "quoted context", author: "+15550002222" },
          groupInfo: { groupId: "g1", groupName: "Test Group" },
          attachments: [],
        },
      }),
    );

    expect(capture.ctx).toBeTruthy();
    expect(capture.ctx?.BodyForAgent).toBe('[Replying to: "quoted context"]\n\nfollow-up');
    expect(capture.ctx?.ReplyToBody).toBe("quoted context");
    expect(capture.ctx?.ReplyToSender).toBe("+15550002222");
    expect(capture.ctx?.ReplyToIsQuote).toBe(true);
  });

  it("forwards all fetched attachments via MediaPaths/MediaTypes", async () => {
    const handler = createSignalEventHandler(
      createBaseSignalEventHandlerDeps({
        cfg: {
          messages: { inbound: { debounceMs: 0 } },
          channels: { signal: { dmPolicy: "open", allowFrom: ["*"] } },
        },
        ignoreAttachments: false,
        fetchAttachment: async ({ attachment }) => ({
          path: `/tmp/${String(attachment.id)}.dat`,
          contentType: attachment.id === "a1" ? "image/jpeg" : undefined,
        }),
        historyLimit: 0,
      }),
    );

    await handler(
      createSignalReceiveEvent({
        dataMessage: {
          message: "",
          attachments: [{ id: "a1", contentType: "image/jpeg" }, { id: "a2" }],
        },
      }),
    );

    expect(capture.ctx).toBeTruthy();
    expect(capture.ctx?.MediaPath).toBe("/tmp/a1.dat");
    expect(capture.ctx?.MediaType).toBe("image/jpeg");
    expect(capture.ctx?.MediaPaths).toEqual(["/tmp/a1.dat", "/tmp/a2.dat"]);
    expect(capture.ctx?.MediaUrls).toEqual(["/tmp/a1.dat", "/tmp/a2.dat"]);
    expect(capture.ctx?.MediaTypes).toEqual(["image/jpeg", "application/octet-stream"]);
  });

  it("uses sticker placeholders for sticker-only inbound messages before generic attachments", async () => {
    const handler = createSignalEventHandler(
      createBaseSignalEventHandlerDeps({
        cfg: {
          messages: { inbound: { debounceMs: 0 } },
          channels: { signal: { dmPolicy: "open", allowFrom: ["*"] } },
        },
        historyLimit: 0,
        ignoreAttachments: true,
      }),
    );

    await handler(
      createSignalReceiveEvent({
        dataMessage: {
          message: "",
          attachments: [{ id: "sticker-asset" }],
          sticker: { packId: "pack-id", stickerId: 5 },
        },
      }),
    );

    expect(capture.ctx).toBeTruthy();
    expect(capture.ctx?.BodyForAgent).toBe("<media:sticker>");
  });

  it("drops own UUID inbound messages when only accountUuid is configured", async () => {
    const ownUuid = "123e4567-e89b-12d3-a456-426614174000";
    const handler = createSignalEventHandler(
      createBaseSignalEventHandlerDeps({
        cfg: {
          messages: { inbound: { debounceMs: 0 } },
          channels: { signal: { dmPolicy: "open", allowFrom: ["*"], accountUuid: ownUuid } },
        },
        account: undefined,
        accountUuid: ownUuid,
        historyLimit: 0,
      }),
    );

    await handler(
      createSignalReceiveEvent({
        sourceNumber: null,
        sourceUuid: ownUuid,
        dataMessage: {
          message: "self message",
          attachments: [],
        },
      }),
    );

    expect(capture.ctx).toBeUndefined();
    expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
  });

  it("drops sync envelopes when syncMessage is present but null", async () => {
    const handler = createSignalEventHandler(
      createBaseSignalEventHandlerDeps({
        cfg: {
          messages: { inbound: { debounceMs: 0 } },
          channels: { signal: { dmPolicy: "open", allowFrom: ["*"] } },
        },
        historyLimit: 0,
      }),
    );

    await handler(
      createSignalReceiveEvent({
        syncMessage: null,
        dataMessage: {
          message: "replayed sentTranscript envelope",
          attachments: [],
        },
      }),
    );

    expect(capture.ctx).toBeUndefined();
    expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
  });
});
