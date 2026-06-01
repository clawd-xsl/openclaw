import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { beforeAll, describe, expect, it, vi } from "vitest";

let signalMonitorTesting: typeof import("./monitor.js").__testing;

beforeAll(async () => {
  ({ __testing: signalMonitorTesting } = await import("./monitor.js"));
});

describe("signal monitor reply threading", () => {
  it("passes replyToId only on the first text send", async () => {
    const sendMessage = vi.fn(async () => ({ messageId: "m1" }));
    const sender = signalMonitorTesting.createSingleUseSignalReplySender({
      cfg: {} as OpenClawConfig,
      target: "signal:+15550002222",
      baseUrl: "http://signal.local",
      accountId: "work",
      maxBytes: 8 * 1024 * 1024,
      replyToId: "123",
      sendMessage,
    });

    await sender.sendText("abc");
    await sender.sendText("def");

    expect(sendMessage).toHaveBeenNthCalledWith(
      1,
      "signal:+15550002222",
      "abc",
      expect.objectContaining({
        replyToId: "123",
      }),
    );
    expect(sendMessage).toHaveBeenNthCalledWith(
      2,
      "signal:+15550002222",
      "def",
      expect.objectContaining({
        replyToId: undefined,
      }),
    );
  });

  it("passes replyToId only on the first media send", async () => {
    const sendMessage = vi.fn(async () => ({ messageId: "m2" }));
    const sender = signalMonitorTesting.createSingleUseSignalReplySender({
      cfg: {} as OpenClawConfig,
      target: "signal:+15550002222",
      baseUrl: "http://signal.local",
      accountId: "work",
      maxBytes: 8 * 1024 * 1024,
      replyToId: "123",
      sendMessage,
    });

    await sender.sendMedia({
      mediaUrl: "https://example.com/a.jpg",
      caption: "caption",
    });
    await sender.sendMedia({
      mediaUrl: "https://example.com/b.jpg",
      caption: "",
    });

    expect(sendMessage).toHaveBeenNthCalledWith(
      1,
      "signal:+15550002222",
      "caption",
      expect.objectContaining({
        mediaUrl: "https://example.com/a.jpg",
        replyToId: "123",
      }),
    );
    expect(sendMessage).toHaveBeenNthCalledWith(
      2,
      "signal:+15550002222",
      "",
      expect.objectContaining({
        mediaUrl: "https://example.com/b.jpg",
        replyToId: undefined,
      }),
    );
  });
});
