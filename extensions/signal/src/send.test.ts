import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const rpcMock = vi.fn();

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
    config: { account: "+15550001111" },
  }),
}));

vi.mock("./client.js", () => ({
  signalRpcRequest: (...args: unknown[]) => rpcMock(...args),
}));

let sendMessageSignal: typeof import("./send.js").sendMessageSignal;
let sendStickerSignal: typeof import("./send.js").sendStickerSignal;

describe("signal send helpers", () => {
  beforeAll(async () => {
    ({ sendMessageSignal, sendStickerSignal } = await import("./send.js"));
  });

  beforeEach(() => {
    rpcMock.mockReset().mockResolvedValue({ timestamp: 456 });
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
});
