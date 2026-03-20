import { beforeEach, describe, expect, it, vi } from "vitest";
import { sendMessageSignal } from "./send.js";

const rpcMock = vi.fn();

vi.mock("../../../src/config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/config/config.js")>();
  return {
    ...actual,
    loadConfig: () => ({}),
  };
});

vi.mock("./accounts.js", () => ({
  resolveSignalAccount: () => ({
    accountId: "default",
    enabled: true,
    baseUrl: "http://signal.local",
    configured: true,
    config: { account: "+15550001111" },
  }),
}));

vi.mock("./client.js", () => ({
  signalRpcRequest: (...args: unknown[]) => rpcMock(...args),
}));

describe("sendMessageSignal quote params", () => {
  beforeEach(() => {
    rpcMock.mockReset().mockResolvedValue({ timestamp: 123 });
  });

  it("uses kebab-case quote parameters for dm replies", async () => {
    await sendMessageSignal("signal:+15551230000", "hello", {
      textMode: "plain",
      replyToId: "123",
    });

    expect(rpcMock).toHaveBeenCalledWith("send", expect.any(Object), expect.any(Object));
    const params = rpcMock.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(params["quote-timestamp"]).toBe(123);
    expect(params["quote-author"]).toBe("+15551230000");
    expect(params).not.toHaveProperty("quoteTimestamp");
    expect(params).not.toHaveProperty("quoteAuthor");
  });
});
