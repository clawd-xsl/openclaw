// Signal tests cover send plugin behavior.
import { beforeEach, describe, expect, it, vi } from "vitest";

const signalRpcRequestMock = vi.hoisted(() => vi.fn());
const signalTsMocks = vi.hoisted(() => ({
  message: vi.fn(),
  sticker: vi.fn(),
  typing: vi.fn(),
  receipt: vi.fn(),
}));
const resolveOutboundAttachmentFromUrlMock = vi.hoisted(() =>
  vi.fn(async (_params: unknown) => ({ path: "/tmp/image.png", contentType: "image/png" })),
);

vi.mock("./client-adapter.js", () => ({
  signalRpcRequest: (...args: unknown[]) => signalRpcRequestMock(...args),
}));

vi.mock("./signal-ts-runtime.js", () => ({
  sendMessageSignalTs: (...args: unknown[]) => signalTsMocks.message(...args),
  sendStickerSignalTs: (...args: unknown[]) => signalTsMocks.sticker(...args),
  sendTypingSignalTs: (...args: unknown[]) => signalTsMocks.typing(...args),
  sendReadReceiptSignalTs: (...args: unknown[]) => signalTsMocks.receipt(...args),
}));

vi.mock("openclaw/plugin-sdk/media-runtime", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/media-runtime")>(
    "openclaw/plugin-sdk/media-runtime",
  );
  return {
    ...actual,
    resolveOutboundAttachmentFromUrl: (params: unknown) =>
      resolveOutboundAttachmentFromUrlMock(params),
  };
});

const { sendMessageSignal, sendReadReceiptSignal, sendStickerSignal, sendTypingSignal } =
  await import("./send.js");

const SIGNAL_TEST_CFG = {
  channels: {
    signal: {
      accounts: {
        default: {
          httpUrl: "http://signal.test",
          account: "+15550001111",
        },
      },
    },
  },
};

describe("sendMessageSignal receipts", () => {
  beforeEach(() => {
    signalRpcRequestMock.mockReset();
    resolveOutboundAttachmentFromUrlMock.mockClear();
    signalTsMocks.message
      .mockReset()
      .mockResolvedValue({ messageId: "1700000000000", timestamp: 1700000000000 });
    signalTsMocks.sticker
      .mockReset()
      .mockResolvedValue({ messageId: "1700000000001", timestamp: 1700000000001 });
    signalTsMocks.typing.mockReset().mockResolvedValue(true);
    signalTsMocks.receipt.mockReset().mockResolvedValue(true);
  });

  it("routes messages through signal-ts and preserves receipt metadata", async () => {
    const cfg = {
      channels: {
        signal: {
          backend: "signal-ts",
          signalTsStatePath: "/secure/signal/default.json",
        },
      },
    } as never;

    const result = await sendMessageSignal("uuid:123e4567-e89b-12d3-a456-426614174000", "hello", {
      cfg,
      replyToId: "1699999999999",
      quoteAuthor: "uuid:123e4567-e89b-12d3-a456-426614174000",
    });

    expect(signalRpcRequestMock).not.toHaveBeenCalled();
    expect(signalTsMocks.message).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "uuid:123e4567-e89b-12d3-a456-426614174000",
        message: "hello",
        replyToId: "1699999999999",
        quoteAuthor: "uuid:123e4567-e89b-12d3-a456-426614174000",
      }),
    );
    expect(result.receipt.primaryPlatformMessageId).toBe("1700000000000");
    expect(result.receipt.replyToId).toBe("1699999999999");
  });

  it("forwards reply cancellation into direct signal-ts sends", async () => {
    const abortController = new AbortController();
    const cfg = {
      channels: {
        signal: {
          backend: "signal-ts",
          signalTsStatePath: "/secure/signal/default.json",
        },
      },
    } as never;

    await sendMessageSignal("+15551234567", "cancelable", {
      cfg,
      abortSignal: abortController.signal,
    });

    expect(signalTsMocks.message).toHaveBeenCalledWith(
      expect.objectContaining({ abortSignal: abortController.signal }),
    );
  });

  it("does not start a direct signal-ts send for an already-aborted reply", async () => {
    const abortController = new AbortController();
    abortController.abort(new Error("superseded"));
    const cfg = {
      channels: {
        signal: {
          backend: "signal-ts",
          signalTsStatePath: "/secure/signal/default.json",
        },
      },
    } as never;

    await expect(
      sendMessageSignal("+15551234567", "stale", {
        cfg,
        abortSignal: abortController.signal,
      }),
    ).rejects.toThrow("superseded");

    expect(signalTsMocks.message).not.toHaveBeenCalled();
  });

  it("routes typing, receipts, and stickers through signal-ts", async () => {
    const cfg = {
      channels: {
        signal: {
          backend: "signal-ts",
          signalTsStatePath: "/secure/signal/default.json",
        },
      },
    } as never;

    await expect(sendTypingSignal("+15551234567", { cfg })).resolves.toBe(true);
    await expect(sendReadReceiptSignal("+15551234567", 1699999999999, { cfg })).resolves.toBe(true);
    const sticker = await sendStickerSignal("+15551234567", "aabb:1", { cfg });

    expect(signalTsMocks.typing).toHaveBeenCalledOnce();
    expect(signalTsMocks.receipt).toHaveBeenCalledOnce();
    expect(signalTsMocks.sticker).toHaveBeenCalledOnce();
    expect(sticker.receipt.parts[0]?.kind).toBe("media");
    expect(signalRpcRequestMock).not.toHaveBeenCalled();
  });

  it("attaches a text receipt for timestamp results", async () => {
    signalRpcRequestMock.mockResolvedValueOnce({ timestamp: 1234567890 });

    const result = await sendMessageSignal("+15551234567", "hello", {
      cfg: SIGNAL_TEST_CFG,
    });

    expect(result.messageId).toBe("1234567890");
    expect(result.timestamp).toBe(1234567890);
    expect(result.receipt.primaryPlatformMessageId).toBe("1234567890");
    expect(result.receipt.platformMessageIds).toEqual(["1234567890"]);
    expect(result.receipt.raw).toEqual([
      {
        channel: "signal",
        messageId: "1234567890",
        toJid: "+15551234567",
        timestamp: 1234567890,
        meta: { targetType: "recipient" },
      },
    ]);
    expect(result.receipt.parts).toEqual([
      {
        index: 0,
        platformMessageId: "1234567890",
        kind: "text",
        raw: {
          channel: "signal",
          messageId: "1234567890",
          toJid: "+15551234567",
          timestamp: 1234567890,
          meta: { targetType: "recipient" },
        },
      },
    ]);
    expect(result.receipt.sentAt).toBeGreaterThan(0);
  });

  it("adds native quote parameters and receipt metadata for direct replies", async () => {
    signalRpcRequestMock.mockResolvedValueOnce({ timestamp: 1234567894 });

    const result = await sendMessageSignal("+15551234567", "quoted reply", {
      cfg: SIGNAL_TEST_CFG,
      replyToId: "1700000000000",
    });

    expect(signalRpcRequestMock).toHaveBeenCalledWith(
      "send",
      expect.objectContaining({
        quoteTimestamp: 1700000000000,
        quoteAuthor: "+15551234567",
      }),
      expect.any(Object),
    );
    expect(result.receipt.replyToId).toBe("1700000000000");
    expect(result.receipt.parts[0]?.replyToId).toBe("1700000000000");
  });

  it("uses the inbound author for quoted group replies", async () => {
    signalRpcRequestMock.mockResolvedValueOnce({ timestamp: 1234567895 });

    await sendMessageSignal("group:group-1", "quoted reply", {
      cfg: SIGNAL_TEST_CFG,
      replyToId: "1700000000001",
      quoteAuthor: "123e4567-e89b-12d3-a456-426614174000",
    });

    expect(signalRpcRequestMock).toHaveBeenCalledWith(
      "send",
      expect.objectContaining({
        groupId: "group-1",
        quoteTimestamp: 1700000000001,
        quoteAuthor: "123e4567-e89b-12d3-a456-426614174000",
      }),
      expect.any(Object),
    );
  });

  it.each(["not-a-timestamp", "0", "0x18bcfe56800", "1700000000000.5"])(
    "does not emit malformed quote timestamp %s",
    async (replyToId) => {
      signalRpcRequestMock.mockResolvedValueOnce({ timestamp: 1234567896 });

      const result = await sendMessageSignal("+15551234567", "plain reply", {
        cfg: SIGNAL_TEST_CFG,
        replyToId,
      });

      const requestParams = signalRpcRequestMock.mock.calls[0]?.[1] as Record<string, unknown>;
      expect(requestParams).not.toHaveProperty("quoteTimestamp");
      expect(requestParams).not.toHaveProperty("quoteAuthor");
      expect(result.receipt.replyToId).toBeUndefined();
    },
  );

  it("sends installed sticker specs with media receipts", async () => {
    signalRpcRequestMock.mockResolvedValueOnce({ timestamp: 1234567897 });

    const result = await sendStickerSignal(
      "group:group-1",
      " 00ABAC3BC18D7F599BFF2325DC306D43:02 ",
      {
        cfg: SIGNAL_TEST_CFG,
      },
    );

    expect(signalRpcRequestMock).toHaveBeenCalledWith(
      "send",
      {
        account: "+15550001111",
        groupId: "group-1",
        sticker: "00abac3bc18d7f599bff2325dc306d43:2",
      },
      expect.any(Object),
    );
    expect(result.receipt.parts[0]?.kind).toBe("media");
    expect(result.receipt.platformMessageIds).toEqual(["1234567897"]);
  });

  it("rejects malformed sticker specs before RPC dispatch", async () => {
    const invalidSpecs = [
      { spec: "missing-sticker-index", error: /packId:stickerId/ },
      { spec: "abc:2", error: /even-length hex/ },
      { spec: "aa:9007199254740992", error: /non-negative integer/ },
      { spec: `${"aa".repeat(65)}:1`, error: /at most 128 hex characters/ },
      { spec: `${"aa".repeat(128)}:1`, error: /at most 256 characters/ },
    ];

    for (const { spec, error } of invalidSpecs) {
      await expect(
        sendStickerSignal("+15551234567", spec, {
          cfg: SIGNAL_TEST_CFG,
        }),
      ).rejects.toThrow(error);
    }
    expect(signalRpcRequestMock).not.toHaveBeenCalled();
  });

  it("attaches a media receipt for attachment sends", async () => {
    signalRpcRequestMock.mockResolvedValueOnce({ timestamp: 1234567891 });

    const result = await sendMessageSignal("group:group-1", "", {
      cfg: SIGNAL_TEST_CFG,
      mediaUrl: "/tmp/image.png",
      mediaLocalRoots: ["/tmp"],
    });

    expect(resolveOutboundAttachmentFromUrlMock).toHaveBeenCalled();
    expect(result.messageId).toBe("1234567891");
    expect(result.timestamp).toBe(1234567891);
    expect(result.receipt.primaryPlatformMessageId).toBe("1234567891");
    expect(result.receipt.platformMessageIds).toEqual(["1234567891"]);
    expect(result.receipt.raw).toEqual([
      {
        channel: "signal",
        messageId: "1234567891",
        chatId: "group-1",
        timestamp: 1234567891,
        meta: { targetType: "group" },
      },
    ]);
    expect(result.receipt.parts).toEqual([
      {
        index: 0,
        platformMessageId: "1234567891",
        kind: "media",
        raw: {
          channel: "signal",
          messageId: "1234567891",
          chatId: "group-1",
          timestamp: 1234567891,
          meta: { targetType: "group" },
        },
      },
    ]);
    expect(result.receipt.sentAt).toBeGreaterThan(0);
  });

  it("does not invent platform ids when signal-cli omits a timestamp", async () => {
    signalRpcRequestMock.mockResolvedValueOnce({});

    const result = await sendMessageSignal("+15551234567", "hello", {
      cfg: SIGNAL_TEST_CFG,
    });

    expect(result.messageId).toBe("unknown");
    expect(result.receipt.platformMessageIds).toStrictEqual([]);
  });

  it("does not add approval reactions to ordinary outbound approval-looking text", async () => {
    signalRpcRequestMock.mockResolvedValueOnce({ timestamp: 1234567892 });
    const text = [
      "Here is the command you asked about:",
      "/approve exec-live-approval allow-once|deny",
    ].join("\n");

    await sendMessageSignal("+15551234567", text, {
      cfg: {
        ...SIGNAL_TEST_CFG,
        channels: {
          signal: {
            ...SIGNAL_TEST_CFG.channels.signal,
            allowFrom: ["+15551234567"],
          },
        },
        approvals: {
          exec: {
            enabled: true,
            mode: "targets",
            targets: [{ channel: "signal", to: "+15551234567" }],
          },
        },
      },
    });

    expect(signalRpcRequestMock).toHaveBeenCalledWith(
      "send",
      expect.objectContaining({ message: text }),
      expect.any(Object),
    );
  });

  it("does not add approval reactions to ordinary outbound text quoting a full prompt", async () => {
    signalRpcRequestMock.mockResolvedValueOnce({ timestamp: 1234567893 });
    const text = [
      "The docs show this example:",
      "Exec approval required",
      "ID: exec-live-approval",
      "",
      "Reply with: /approve exec-live-approval allow-once|deny",
    ].join("\n");

    await sendMessageSignal("+15551234567", text, {
      cfg: {
        ...SIGNAL_TEST_CFG,
        channels: {
          signal: {
            ...SIGNAL_TEST_CFG.channels.signal,
            allowFrom: ["+15551234567"],
          },
        },
        approvals: {
          exec: {
            enabled: true,
            mode: "targets",
            targets: [{ channel: "signal", to: "+15551234567" }],
          },
        },
      },
    });

    expect(signalRpcRequestMock).toHaveBeenCalledWith(
      "send",
      expect.objectContaining({ message: text }),
      expect.any(Object),
    );
  });
});
