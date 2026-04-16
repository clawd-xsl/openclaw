import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { beforeAll, describe, expect, it, vi } from "vitest";

let signalPlugin: typeof import("./channel.js").signalPlugin;

beforeAll(async () => {
  ({ signalPlugin } = await import("./channel.js"));
});

describe("signalPlugin threading", () => {
  it("honors per-account replyToMode overrides", () => {
    const resolveReplyToMode = signalPlugin.threading?.resolveReplyToMode;
    if (!resolveReplyToMode) {
      throw new Error("Expected signalPlugin.threading.resolveReplyToMode to be defined");
    }

    const cfg = {
      channels: {
        signal: {
          replyToMode: "all",
          accounts: {
            work: {
              account: "+15550001111",
              replyToMode: "first",
            },
          },
        },
      },
    } as OpenClawConfig;

    expect(resolveReplyToMode({ cfg, accountId: "work" })).toBe("first");
    expect(resolveReplyToMode({ cfg, accountId: "default" })).toBe("all");
  });
});

describe("signalPlugin outbound", () => {
  it("uses replyToId only for the first formatted text chunk", async () => {
    const sendMessageSignal = vi.fn(async () => ({ messageId: "m1" }));

    const results = await signalPlugin.outbound!.sendFormattedText!({
      cfg: {
        channels: {
          signal: {
            textChunkLimit: 3,
          },
        },
      } as OpenClawConfig,
      to: "signal:+15550002222",
      text: "abcdef",
      replyToId: "1700000000000",
      deps: {
        signal: sendMessageSignal,
      },
    });

    expect(sendMessageSignal).toHaveBeenCalledTimes(2);
    expect(sendMessageSignal).toHaveBeenNthCalledWith(
      1,
      "signal:+15550002222",
      "abc",
      expect.objectContaining({
        replyToId: "1700000000000",
      }),
    );
    expect(sendMessageSignal).toHaveBeenNthCalledWith(
      2,
      "signal:+15550002222",
      "def",
      expect.objectContaining({
        replyToId: undefined,
      }),
    );
    expect(results).toHaveLength(2);
    expect(results[0]?.channel).toBe("signal");
  });

  it("forwards replyToId through attached media sends", async () => {
    const sendMessageSignal = vi.fn(async () => ({ messageId: "m2" }));

    const result = await signalPlugin.outbound!.sendMedia!({
      cfg: {} as OpenClawConfig,
      to: "signal:+15550002222",
      text: "caption",
      mediaUrl: "https://example.com/file.jpg",
      replyToId: "1700000000000",
      deps: {
        signal: sendMessageSignal,
      },
    });

    expect(sendMessageSignal).toHaveBeenCalledWith(
      "signal:+15550002222",
      "caption",
      expect.objectContaining({
        mediaUrl: "https://example.com/file.jpg",
        replyToId: "1700000000000",
      }),
    );
    expect(result).toMatchObject({ channel: "signal", messageId: "m2" });
  });
});
