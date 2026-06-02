import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ResolvedSignalAccount } from "./accounts.js";

const mocks = vi.hoisted(() => {
  return {
    abortController: undefined as AbortController | undefined,
    ackIncoming: vi.fn(async () => undefined),
    computeBackoff: vi.fn(() => 1),
    connectCount: 0,
    decodeSignalEnvelope: vi.fn(() => ({})),
    decryptIncomingEnvelope: vi.fn(),
    disconnect: vi.fn(async () => undefined),
    disconnectError: undefined as Error | undefined,
    emitIncomingOnFirstConnect: false,
    normalizeDecryptedIncomingMessage: vi.fn(),
    openRepository: vi.fn(),
    sendMessage: vi.fn(async (..._args: unknown[]) => ({ timestamp: 123 })),
    sleepWithAbort: vi.fn(async () => undefined),
  };
});

vi.mock("openclaw/plugin-sdk/runtime-env", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/runtime-env")>(
    "openclaw/plugin-sdk/runtime-env",
  );
  return {
    ...actual,
    computeBackoff: mocks.computeBackoff,
    sleepWithAbort: mocks.sleepWithAbort,
  };
});

vi.mock("@openclaw/signal-ts", () => {
  class MockSignalTsClient {
    readonly #handlers = new Map<string, Set<(value: unknown) => void>>();

    on(event: string, handler: (value: unknown) => void): () => void {
      const handlers = this.#handlers.get(event) ?? new Set<(value: unknown) => void>();
      handlers.add(handler);
      this.#handlers.set(event, handlers);
      return () => {
        handlers.delete(handler);
      };
    }

    async connect(): Promise<void> {
      mocks.connectCount += 1;
      if (mocks.connectCount === 1) {
        queueMicrotask(() => {
          if (mocks.emitIncomingOnFirstConnect) {
            this.#emit("incoming", {
              envelope: new Uint8Array([1, 2, 3]),
              timestamp: 1700000000000,
              ack: mocks.ackIncoming,
            });
          }
          setTimeout(() => {
            this.#emit("disconnected", mocks.disconnectError ?? new Error("kicked"));
          }, 0);
        });
      } else {
        mocks.abortController?.abort();
      }
    }

    async sendMessage(...args: unknown[]): Promise<{ timestamp: number }> {
      return await mocks.sendMessage(...args);
    }

    async disconnect(): Promise<void> {
      await mocks.disconnect();
    }

    #emit(event: string, value: unknown): void {
      for (const handler of this.#handlers.get(event) ?? []) {
        handler(value);
      }
    }
  }

  return {
    FileSignalRepository: {
      open: mocks.openRepository,
    },
    SignalTsClient: MockSignalTsClient,
    base64ToBytes: vi.fn(() => new Uint8Array()),
    bytesToBase64: vi.fn(() => ""),
    createLibsignalStores: vi.fn(() => ({})),
    createSignalLocalAddress: vi.fn(() => ({})),
    decodeSignalEnvelope: mocks.decodeSignalEnvelope,
    decryptIncomingEnvelope: mocks.decryptIncomingEnvelope,
    deriveAccessKeyBase64FromProfileKeyBase64: vi.fn(() => ""),
    downloadSignalAttachment: vi.fn(),
    normalizeDecryptedIncomingMessage: mocks.normalizeDecryptedIncomingMessage,
    parseSignalRecipientTarget: vi.fn((value: string) => ({ kind: "raw", value })),
    preKeyAuthFromBase64: vi.fn(() => ({})),
  };
});

function createSignalTsAccountInfo(): ResolvedSignalAccount {
  return {
    accountId: "default",
    baseUrl: "",
    configured: true,
    enabled: true,
    config: {
      backend: "signal-ts",
      signalTsStatePath: "/tmp/signal-ts-state.json",
    },
  };
}

function createSignalTsIncomingMessage() {
  return {
    kind: "data",
    sender: { serviceId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" },
    timestamp: 1700000000000,
    serverTimestamp: 1700000000000,
    body: "hello",
    attachments: [],
    bodyRanges: [],
    message: {},
  };
}

describe("signal-ts runtime monitor", () => {
  beforeEach(() => {
    mocks.abortController = undefined;
    mocks.ackIncoming.mockClear();
    mocks.computeBackoff.mockClear();
    mocks.connectCount = 0;
    mocks.decodeSignalEnvelope.mockReset().mockReturnValue({});
    mocks.decryptIncomingEnvelope.mockReset().mockResolvedValue({});
    mocks.disconnect.mockClear();
    mocks.disconnectError = undefined;
    mocks.emitIncomingOnFirstConnect = false;
    mocks.normalizeDecryptedIncomingMessage.mockReset().mockReturnValue([]);
    mocks.openRepository.mockReset().mockResolvedValue({
      getAccount: vi.fn(async () => ({
        account: {
          device: {
            aci: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            deviceId: 2,
            e164: "+15550001111",
          },
        },
      })),
      getGroup: vi.fn(async () => undefined),
      getRecipientByAci: vi.fn(async () => ({
        aci: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        e164: "+15550002222",
        name: "Alice",
      })),
      getRecipientByE164: vi.fn(async () => undefined),
      setRecipient: vi.fn(async () => undefined),
    });
    mocks.sendMessage.mockClear().mockResolvedValue({ timestamp: 123 });
    mocks.sleepWithAbort.mockClear();
  });

  it("reconnects after the Signal chat connection is interrupted", async () => {
    const { monitorSignalTsProvider } = await import("./signal-ts-runtime.js");
    const abortController = new AbortController();
    mocks.abortController = abortController;
    const runtime: RuntimeEnv = {
      error: vi.fn(),
      exit: vi.fn(),
      log: vi.fn(),
    };

    await monitorSignalTsProvider({
      accountInfo: createSignalTsAccountInfo(),
      abortSignal: abortController.signal,
      reconnectPolicy: {
        initialMs: 1,
        maxMs: 1,
        factor: 1,
        jitter: 0,
      },
      runtime,
      onEvent: vi.fn(async () => undefined),
    });

    expect(mocks.connectCount).toBe(2);
    expect(mocks.computeBackoff).toHaveBeenCalledTimes(1);
    expect(mocks.sleepWithAbort).toHaveBeenCalledWith(1, abortController.signal);
    expect(runtime.error).toHaveBeenCalledWith(
      expect.stringContaining("signal-ts: connection lost: Error: kicked"),
    );
  });

  it("reuses the active monitor client for sends handled during inbound events", async () => {
    const { monitorSignalTsProvider, sendMessageSignalTs } = await import("./signal-ts-runtime.js");
    const abortController = new AbortController();
    mocks.abortController = abortController;
    mocks.emitIncomingOnFirstConnect = true;
    mocks.normalizeDecryptedIncomingMessage.mockReturnValue([createSignalTsIncomingMessage()]);
    const accountInfo = createSignalTsAccountInfo();
    const runtime: RuntimeEnv = {
      error: vi.fn(),
      exit: vi.fn(),
      log: vi.fn(),
    };
    const onEvent = vi.fn(async (_event: { event: "receive"; data: string }) => {
      await sendMessageSignalTs({
        cfg: {},
        accountInfo,
        to: "signal:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        message: "reply",
      });
    });

    await monitorSignalTsProvider({
      accountInfo,
      abortSignal: abortController.signal,
      reconnectPolicy: {
        initialMs: 1,
        maxMs: 1,
        factor: 1,
        jitter: 0,
      },
      runtime,
      onEvent,
    });

    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(mocks.sendMessage).toHaveBeenCalledTimes(1);
    expect(mocks.connectCount).toBe(2);
  });

  it("emits connected-elsewhere as a normal receive event and throws without reconnecting", async () => {
    const { monitorSignalTsProvider } = await import("./signal-ts-runtime.js");
    const abortController = new AbortController();
    mocks.abortController = abortController;
    mocks.disconnectError = new Error(
      "ConnectedElsewhere - DisconnectCause: connected elsewhere with the same credentials",
    );
    mocks.emitIncomingOnFirstConnect = true;
    mocks.normalizeDecryptedIncomingMessage.mockReturnValue([createSignalTsIncomingMessage()]);
    const runtime: RuntimeEnv = {
      error: vi.fn(),
      exit: vi.fn(),
      log: vi.fn(),
    };
    const onEvent = vi.fn(async (_event: { event: "receive"; data: string }) => undefined);

    await expect(
      monitorSignalTsProvider({
        accountInfo: createSignalTsAccountInfo(),
        abortSignal: abortController.signal,
        reconnectPolicy: {
          initialMs: 1,
          maxMs: 1,
          factor: 1,
          jitter: 0,
        },
        runtime,
        onEvent,
      }),
    ).rejects.toThrow("ConnectedElsewhere");

    expect(mocks.connectCount).toBe(1);
    expect(mocks.computeBackoff).not.toHaveBeenCalled();
    expect(mocks.sleepWithAbort).not.toHaveBeenCalled();
    expect(onEvent).toHaveBeenCalledTimes(2);
    const diagnostic = JSON.parse(onEvent.mock.calls[1][0].data);
    expect(diagnostic.envelope.sourceNumber).toBe("+15550002222");
    expect(diagnostic.envelope.dataMessage.message).toContain("signal-ts monitor fatal");
  });

  it("ignores server delivery receipt envelopes without logging inbound failure", async () => {
    const { monitorSignalTsProvider } = await import("./signal-ts-runtime.js");
    const abortController = new AbortController();
    mocks.abortController = abortController;
    mocks.emitIncomingOnFirstConnect = true;
    mocks.decodeSignalEnvelope.mockReturnValue({ type: 5 });
    mocks.decryptIncomingEnvelope.mockRejectedValue(
      new Error("Signal envelope does not contain encrypted content"),
    );
    const runtime: RuntimeEnv = {
      error: vi.fn(),
      exit: vi.fn(),
      log: vi.fn(),
    };

    await monitorSignalTsProvider({
      accountInfo: createSignalTsAccountInfo(),
      abortSignal: abortController.signal,
      reconnectPolicy: {
        initialMs: 1,
        maxMs: 1,
        factor: 1,
        jitter: 0,
      },
      runtime,
      onEvent: vi.fn(async (_event: { event: "receive"; data: string }) => undefined),
    });

    expect(runtime.error).not.toHaveBeenCalledWith(
      expect.stringContaining("signal-ts inbound failed"),
    );
  });
});
