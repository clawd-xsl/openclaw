import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../../src/config/config.js";
import {
  flush,
  getSignalToolResultTestMocks,
  installSignalToolResultTestHooks,
  setSignalToolResultTestConfig,
} from "./monitor.tool-result.test-harness.js";

installSignalToolResultTestHooks();

const { monitorSignalProvider } = await import("./monitor.js");
const { replyMock, sendMock, streamMock } = getSignalToolResultTestMocks();

const SIGNAL_BASE_URL = "http://127.0.0.1:8080";

type MonitorSignalProviderOptions = Parameters<typeof monitorSignalProvider>[0];

function createSignalConfig(overrides: Record<string, unknown> = {}): OpenClawConfig {
  return {
    channels: {
      signal: {
        autoStart: false,
        dmPolicy: "open",
        allowFrom: ["*"],
        ...overrides,
      },
    },
  };
}

async function runMonitorWithMocks(opts: MonitorSignalProviderOptions) {
  return monitorSignalProvider(opts);
}

async function receiveSignalPayloads(params: {
  payloads: unknown[];
  opts?: Partial<MonitorSignalProviderOptions>;
}) {
  const abortController = new AbortController();
  streamMock.mockImplementation(async ({ onEvent }) => {
    for (const payload of params.payloads) {
      await onEvent({
        event: "receive",
        data: JSON.stringify(payload),
      });
    }
    abortController.abort();
  });

  await runMonitorWithMocks({
    autoStart: false,
    baseUrl: SIGNAL_BASE_URL,
    abortSignal: abortController.signal,
    ...params.opts,
  });

  await flush();
}

function createDirectMessageEnvelope() {
  return {
    envelope: {
      sourceNumber: "+15550001111",
      sourceName: "Ada",
      timestamp: 1,
      dataMessage: {
        message: "hello",
      },
    },
  };
}

describe("monitorSignalProvider reply threading", () => {
  it("passes replyToId only on the first text chunk", async () => {
    setSignalToolResultTestConfig(
      createSignalConfig({
        textChunkLimit: 3,
      }),
    );
    replyMock.mockResolvedValue({
      text: "abcdef",
      replyToId: "123",
    });

    await receiveSignalPayloads({
      payloads: [createDirectMessageEnvelope()],
    });

    expect(sendMock).toHaveBeenCalledTimes(2);
    expect(sendMock.mock.calls[0]?.[1]).toBe("abc");
    expect((sendMock.mock.calls[0]?.[2] as Record<string, unknown>)["replyToId"]).toBe("123");
    expect(sendMock.mock.calls[1]?.[1]).toBe("def");
    expect((sendMock.mock.calls[1]?.[2] as Record<string, unknown>)["replyToId"]).toBeUndefined();
  });

  it("passes replyToId only on the first media send", async () => {
    setSignalToolResultTestConfig(createSignalConfig());
    replyMock.mockResolvedValue({
      text: "caption",
      mediaUrls: ["https://example.com/a.jpg", "https://example.com/b.jpg"],
      replyToId: "123",
    });

    await receiveSignalPayloads({
      payloads: [createDirectMessageEnvelope()],
    });

    expect(sendMock).toHaveBeenCalledTimes(2);
    expect(sendMock.mock.calls[0]?.[1]).toBe("caption");
    expect((sendMock.mock.calls[0]?.[2] as Record<string, unknown>)["mediaUrl"]).toBe(
      "https://example.com/a.jpg",
    );
    expect((sendMock.mock.calls[0]?.[2] as Record<string, unknown>)["replyToId"]).toBe("123");
    expect(sendMock.mock.calls[1]?.[1]).toBe("");
    expect((sendMock.mock.calls[1]?.[2] as Record<string, unknown>)["mediaUrl"]).toBe(
      "https://example.com/b.jpg",
    );
    expect((sendMock.mock.calls[1]?.[2] as Record<string, unknown>)["replyToId"]).toBeUndefined();
  });
});
