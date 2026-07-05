// Signal tests cover monitor reply threading behavior.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createNonExitingRuntime } from "openclaw/plugin-sdk/runtime-env";
import { describe, expect, it, vi } from "vitest";

const sendMessageSignalMock = vi.hoisted(() => vi.fn());

vi.mock("./send.js", () => ({
  sendMessageSignal: sendMessageSignalMock,
  sendReadReceiptSignal: vi.fn(),
  sendTypingSignal: vi.fn(),
}));

vi.mock("./approval-reactions.js", () => ({
  addSignalApprovalReactionHintToStructuredPayload: vi.fn(() => null),
  registerSignalApprovalReactionTargetForDeliveredPayload: vi.fn(),
}));

const { deliverReplies } = await import("./monitor.js");

describe("Signal monitor reply threading", () => {
  it("forwards the owning turn abort signal to every platform send", async () => {
    const abortController = new AbortController();
    sendMessageSignalMock
      .mockReset()
      .mockResolvedValueOnce({ messageId: "message-1" })
      .mockResolvedValueOnce({ messageId: "message-2" });

    await deliverReplies({
      cfg: {} as OpenClawConfig,
      replies: [{ text: "abcdef" }],
      target: "signal:+15550002222",
      baseUrl: "http://signal.test",
      account: "+15550001111",
      accountId: "work",
      runtime: { ...createNonExitingRuntime(), log: vi.fn() },
      maxBytes: 8 * 1024 * 1024,
      textLimit: 3,
      chunkMode: "length",
      abortSignal: abortController.signal,
    });

    expect(sendMessageSignalMock).toHaveBeenCalledTimes(2);
    expect(sendMessageSignalMock.mock.calls[0]?.[2]).toEqual(
      expect.objectContaining({ abortSignal: abortController.signal }),
    );
    expect(sendMessageSignalMock.mock.calls[1]?.[2]).toEqual(
      expect.objectContaining({ abortSignal: abortController.signal }),
    );
  });

  it("quotes only the first platform send with the inbound group author", async () => {
    sendMessageSignalMock
      .mockReset()
      .mockResolvedValueOnce({ messageId: "message-1" })
      .mockResolvedValueOnce({ messageId: "message-2" });

    await deliverReplies({
      cfg: {} as OpenClawConfig,
      replies: [{ text: "abcdef", replyToId: "1700000000000" }],
      target: "group:group-1",
      baseUrl: "http://signal.test",
      account: "+15550001111",
      accountId: "work",
      runtime: { ...createNonExitingRuntime(), log: vi.fn() },
      maxBytes: 8 * 1024 * 1024,
      textLimit: 3,
      chunkMode: "length",
      quoteAuthor: "123e4567-e89b-12d3-a456-426614174000",
    });

    expect(sendMessageSignalMock).toHaveBeenCalledTimes(2);
    expect(sendMessageSignalMock.mock.calls[0]?.[2]).toEqual(
      expect.objectContaining({
        replyToId: "1700000000000",
        quoteAuthor: "123e4567-e89b-12d3-a456-426614174000",
      }),
    );
    expect(sendMessageSignalMock.mock.calls[1]?.[2]).not.toHaveProperty("replyToId");
    expect(sendMessageSignalMock.mock.calls[1]?.[2]).not.toHaveProperty("quoteAuthor");
  });

  it("does not misattribute an explicit older-message quote to the current sender", async () => {
    sendMessageSignalMock.mockReset().mockResolvedValueOnce({ messageId: "message-1" });

    await deliverReplies({
      cfg: {} as OpenClawConfig,
      replies: [
        {
          text: "reply",
          replyToId: "1699999999999",
          replyToTag: true,
          replyToCurrent: false,
        },
      ],
      target: "group:group-1",
      baseUrl: "http://signal.test",
      account: "+15550001111",
      accountId: "work",
      runtime: { ...createNonExitingRuntime(), log: vi.fn() },
      maxBytes: 8 * 1024 * 1024,
      textLimit: 4000,
      chunkMode: "length",
      quoteAuthor: "uuid:current-sender",
    });

    expect(sendMessageSignalMock.mock.calls[0]?.[2]).toEqual(
      expect.objectContaining({ replyToId: "1699999999999" }),
    );
    expect(sendMessageSignalMock.mock.calls[0]?.[2]).not.toHaveProperty("quoteAuthor");
  });
});
