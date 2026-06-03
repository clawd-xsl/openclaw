import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const rpcMock = vi.fn();
const signalTsSendMock = vi.fn();
const signalTsTypingMock = vi.fn();
const signalTsReceiptMock = vi.fn();
const signalTsStickerMock = vi.fn();
let accountConfig: Record<string, unknown> = { account: "+15550001111" };

vi.mock("openclaw/plugin-sdk/config-runtime", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/config-runtime")>(
    "openclaw/plugin-sdk/config-runtime",
  );
  return {
    ...actual,
    loadConfig: () => ({}),
  };
});

vi.mock("./accounts.js", () => ({
  resolveSignalAccount: () => ({
    accountId: "work",
    enabled: true,
    baseUrl: "http://signal.local",
    configured: true,
    config: accountConfig,
  }),
}));

vi.mock("./client.js", () => ({
  signalRpcRequest: (...args: unknown[]) => rpcMock(...args),
}));

vi.mock("./signal-ts-runtime.js", () => ({
  sendMessageSignalTs: (...args: unknown[]) => signalTsSendMock(...args),
  sendTypingSignalTs: (...args: unknown[]) => signalTsTypingMock(...args),
  sendReadReceiptSignalTs: (...args: unknown[]) => signalTsReceiptMock(...args),
  sendStickerSignalTs: (...args: unknown[]) => signalTsStickerMock(...args),
}));

let sendMessageSignal: typeof import("./send.js").sendMessageSignal;
let sendReadReceiptSignal: typeof import("./send.js").sendReadReceiptSignal;
let sendStickerSignal: typeof import("./send.js").sendStickerSignal;
let sendTypingSignal: typeof import("./send.js").sendTypingSignal;

describe("signal send helpers", () => {
  beforeAll(async () => {
    ({ sendMessageSignal, sendReadReceiptSignal, sendStickerSignal, sendTypingSignal } =
      await import("./send.js"));
  });

  beforeEach(() => {
    accountConfig = { account: "+15550001111" };
    rpcMock.mockReset().mockResolvedValue({ timestamp: 456 });
    signalTsSendMock.mockReset().mockResolvedValue({ messageId: "789", timestamp: 789 });
    signalTsTypingMock.mockReset().mockResolvedValue(true);
    signalTsReceiptMock.mockReset().mockResolvedValue(true);
    signalTsStickerMock.mockReset().mockResolvedValue({ messageId: "987", timestamp: 987 });
  });

  it("encodes DM replyToId as kebab-case quote params", async () => {
    const result = await sendMessageSignal("signal:+15550002222", "reply", {
      accountId: "work",
      replyToId: "1700000000000",
      textMode: "plain",
    });

    expect(result).toEqual({ messageId: "456", timestamp: 456 });
    expect(rpcMock).toHaveBeenCalledWith(
      "send",
      {
        account: "+15550001111",
        message: "reply",
        recipient: ["+15550002222"],
        "quote-author": "+15550002222",
        "quote-timestamp": 1700000000000,
      },
      {
        baseUrl: "http://signal.local",
        timeoutMs: undefined,
        abortSignal: undefined,
      },
    );
  });

  it("passes abortSignal through message sends", async () => {
    const abortController = new AbortController();

    await sendMessageSignal("signal:+15550002222", "reply", {
      accountId: "work",
      textMode: "plain",
      abortSignal: abortController.signal,
    });

    expect(rpcMock).toHaveBeenCalledWith(
      "send",
      expect.objectContaining({
        account: "+15550001111",
        message: "reply",
        recipient: ["+15550002222"],
      }),
      expect.objectContaining({
        abortSignal: abortController.signal,
      }),
    );
  });

  it("routes message sends through signal-ts when configured", async () => {
    accountConfig = {
      account: "+15550001111",
      backend: "signal-ts",
      signalTsStatePath: "/tmp/signal-ts-state.json",
    };
    const abortController = new AbortController();

    const result = await sendMessageSignal(
      "signal:uuid:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      "reply",
      {
        accountId: "work",
        textMode: "plain",
        abortSignal: abortController.signal,
      },
    );

    expect(result).toEqual({ messageId: "789", timestamp: 789 });
    expect(rpcMock).not.toHaveBeenCalled();
    expect(signalTsSendMock).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "signal:uuid:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        message: "reply",
        abortSignal: abortController.signal,
        accountInfo: expect.objectContaining({
          accountId: "work",
          config: expect.objectContaining({
            backend: "signal-ts",
            signalTsStatePath: "/tmp/signal-ts-state.json",
          }),
        }),
      }),
    );
  });

  it("routes typing through signal-ts even when RPC context is explicit", async () => {
    accountConfig = {
      account: "+15550001111",
      backend: "signal-ts",
      signalTsStatePath: "/tmp/signal-ts-state.json",
    };
    const abortController = new AbortController();

    const result = await sendTypingSignal("signal:uuid:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", {
      baseUrl: "http://127.0.0.1:8080",
      account: "+15550001111",
      accountId: "work",
      abortSignal: abortController.signal,
    });

    expect(result).toBe(true);
    expect(rpcMock).not.toHaveBeenCalled();
    expect(signalTsTypingMock).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "signal:uuid:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        abortSignal: abortController.signal,
        accountInfo: expect.objectContaining({
          accountId: "work",
          config: expect.objectContaining({
            backend: "signal-ts",
          }),
        }),
      }),
    );
  });

  it("routes read receipts through signal-ts even when RPC context is explicit", async () => {
    accountConfig = {
      account: "+15550001111",
      backend: "signal-ts",
      signalTsStatePath: "/tmp/signal-ts-state.json",
    };

    const result = await sendReadReceiptSignal(
      "signal:uuid:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      1700000000000,
      {
        baseUrl: "http://127.0.0.1:8080",
        account: "+15550001111",
        accountId: "work",
      },
    );

    expect(result).toBe(true);
    expect(rpcMock).not.toHaveBeenCalled();
    expect(signalTsReceiptMock).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "signal:uuid:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        targetTimestamp: 1700000000000,
        accountInfo: expect.objectContaining({
          accountId: "work",
          config: expect.objectContaining({
            backend: "signal-ts",
          }),
        }),
      }),
    );
  });

  it("sends Signal sticker specs through the send RPC target params", async () => {
    const result = await sendStickerSignal("signal:group:group-id", "pack-id:5", {
      accountId: "work",
    });

    expect(result).toEqual({ messageId: "456", timestamp: 456 });
    expect(rpcMock).toHaveBeenCalledWith(
      "send",
      {
        account: "+15550001111",
        groupId: "group-id",
        sticker: "pack-id:5",
      },
      {
        baseUrl: "http://signal.local",
        timeoutMs: undefined,
        abortSignal: undefined,
      },
    );
  });

  it("routes stickers through signal-ts when configured", async () => {
    accountConfig = {
      account: "+15550001111",
      backend: "signal-ts",
      signalTsStatePath: "/tmp/signal-ts-state.json",
    };
    const abortController = new AbortController();

    const result = await sendStickerSignal("signal:group:group-id", "aabbccdd:5", {
      accountId: "work",
      abortSignal: abortController.signal,
    });

    expect(result).toEqual({ messageId: "987", timestamp: 987 });
    expect(rpcMock).not.toHaveBeenCalled();
    expect(signalTsStickerMock).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "signal:group:group-id",
        sticker: "aabbccdd:5",
        abortSignal: abortController.signal,
        accountInfo: expect.objectContaining({
          accountId: "work",
          config: expect.objectContaining({
            backend: "signal-ts",
          }),
        }),
      }),
    );
  });
});
