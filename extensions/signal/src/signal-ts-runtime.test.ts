import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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
    downloadSignalAttachment: vi.fn(),
    emitIncomingOnFirstConnect: false,
    signalCdnAgentOptions: [] as unknown[],
    signalCdnFetch: vi.fn(),
    saveMediaBuffer: vi.fn(async () => ({
      path: "/tmp/signal-attachment",
      contentType: "text/plain",
    })),
    normalizeDecryptedIncomingMessage: vi.fn(),
    openRepository: vi.fn(),
    sendReactionMessage: vi.fn(async (..._args: unknown[]) => ({ timestamp: 765 })),
    sendGroupReactionMessage: vi.fn(async (..._args: unknown[]) => ({
      timestamp: 876,
      recipients: 2,
    })),
    sendMessage: vi.fn(async (..._args: unknown[]) => ({ timestamp: 123 })),
    sendStickerMessage: vi.fn(async (..._args: unknown[]) => ({ timestamp: 321 })),
    sendGroupStickerMessage: vi.fn(async (..._args: unknown[]) => ({
      timestamp: 654,
      recipients: 2,
    })),
    uploadAttachment: vi.fn(async (..._args: unknown[]) => ({
      pointer: { cdnKey: "cdn-key", cdnNumber: 2 } as {
        cdnKey: string;
        cdnNumber: number;
        contentType?: string;
      },
    })),
    sleepWithAbort: vi.fn(async () => undefined),
  };
});

vi.mock("undici", () => {
  function MockAgent(this: unknown, options: unknown): void {
    mocks.signalCdnAgentOptions.push(options);
  }
  return {
    Agent: MockAgent,
    fetch: mocks.signalCdnFetch,
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

vi.mock("openclaw/plugin-sdk/media-runtime", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/media-runtime")>(
    "openclaw/plugin-sdk/media-runtime",
  );
  return {
    ...actual,
    saveMediaBuffer: mocks.saveMediaBuffer,
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

    async sendReactionMessage(...args: unknown[]): Promise<{ timestamp: number }> {
      return await mocks.sendReactionMessage(...args);
    }

    async sendGroupReactionMessage(...args: unknown[]): Promise<{
      timestamp: number;
      recipients: number;
    }> {
      return await mocks.sendGroupReactionMessage(...args);
    }

    async sendStickerMessage(...args: unknown[]): Promise<{ timestamp: number }> {
      return await mocks.sendStickerMessage(...args);
    }

    async sendGroupStickerMessage(...args: unknown[]): Promise<{
      timestamp: number;
      recipients: number;
    }> {
      return await mocks.sendGroupStickerMessage(...args);
    }

    async uploadAttachment(...args: unknown[]): Promise<{ pointer: unknown }> {
      return await mocks.uploadAttachment(...args);
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
    base64ToBytes: vi.fn((value: string) => new Uint8Array(Buffer.from(value, "base64"))),
    bytesToBase64: vi.fn((value: Uint8Array) => Buffer.from(value).toString("base64")),
    createLibsignalStores: vi.fn(() => ({})),
    createSignalLocalAddress: vi.fn(() => ({})),
    decodeSignalEnvelope: mocks.decodeSignalEnvelope,
    decryptIncomingEnvelope: mocks.decryptIncomingEnvelope,
    deriveAccessKeyBase64FromProfileKeyBase64: vi.fn(() => ""),
    downloadSignalAttachment: mocks.downloadSignalAttachment,
    hexToBytes: vi.fn((value: string) => new Uint8Array(Buffer.from(value, "hex"))),
    normalizeDecryptedIncomingMessage: mocks.normalizeDecryptedIncomingMessage,
    parseSignalRecipientTarget: vi.fn((raw: string) => {
      let value = raw.trim();
      if (/^signal:/i.test(value)) {
        value = value.slice("signal:".length).trim();
      }
      if (/^uuid:/i.test(value)) {
        return { kind: "aci", aci: value.slice("uuid:".length).trim() };
      }
      if (/^\+[1-9]\d{6,14}$/.test(value)) {
        return { kind: "e164", e164: value };
      }
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
        return { kind: "aci", aci: value };
      }
      return { kind: "username", username: value };
    }),
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
    mocks.downloadSignalAttachment.mockReset();
    mocks.emitIncomingOnFirstConnect = false;
    mocks.signalCdnAgentOptions = [];
    mocks.signalCdnFetch.mockReset();
    mocks.saveMediaBuffer.mockClear();
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
      getStickerPack: vi.fn(async () => undefined),
      getStickerFilePath: vi.fn((packId: string, fileName: string) =>
        path.join("/tmp/signal-ts-state.json.stickers", packId, fileName),
      ),
      setRecipient: vi.fn(async () => undefined),
    });
    mocks.sendReactionMessage.mockClear().mockResolvedValue({ timestamp: 765 });
    mocks.sendGroupReactionMessage.mockClear().mockResolvedValue({ timestamp: 876, recipients: 2 });
    mocks.sendMessage.mockClear().mockResolvedValue({ timestamp: 123 });
    mocks.sendStickerMessage.mockClear().mockResolvedValue({ timestamp: 321 });
    mocks.sendGroupStickerMessage.mockClear().mockResolvedValue({ timestamp: 654, recipients: 2 });
    mocks.uploadAttachment.mockClear().mockResolvedValue({
      pointer: { cdnKey: "cdn-key", cdnNumber: 2 },
    });
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

  it("retries Signal CDN attachment downloads with a scoped TLS fallback fetch", async () => {
    const { fetchSignalTsAttachment } = await import("./signal-ts-runtime.js");
    const normalFetch = vi.fn(async () => {
      throw new Error("fetch failed");
    });
    vi.stubGlobal("fetch", normalFetch);
    mocks.signalCdnFetch.mockResolvedValueOnce(new Response("encrypted"));
    mocks.downloadSignalAttachment.mockImplementationOnce(
      async (params: { fetch?: typeof fetch }) => {
        const response = await params.fetch?.("https://cdn3.signal.org/attachments/cdn-key", {
          method: "GET",
        });
        expect(await response?.text()).toBe("encrypted");
        return new TextEncoder().encode("plain");
      },
    );

    try {
      const result = await fetchSignalTsAttachment({
        accountInfo: createSignalTsAccountInfo(),
        attachment: {
          id: "signal-ts:cdn-key",
          contentType: "text/x-signal-plain",
          size: 5,
          signalTsPointer: {
            cdnKey: "cdn-key",
            cdnNumber: 3,
            key: "a2V5",
            digest: "ZGlnZXN0",
            contentType: "text/x-signal-plain",
            size: 5,
          },
        },
        maxBytes: 1024,
      });

      expect(result).toEqual({ path: "/tmp/signal-attachment", contentType: "text/plain" });
      expect(normalFetch).toHaveBeenCalledOnce();
      expect(mocks.signalCdnFetch).toHaveBeenCalledOnce();
      expect(mocks.signalCdnFetch.mock.calls[0]?.[1]).toMatchObject({
        method: "GET",
        dispatcher: expect.any(Object),
      });
      expect(mocks.signalCdnAgentOptions).toEqual([
        { allowH2: false, connect: { rejectUnauthorized: false } },
      ]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("retries Signal attachment uploads with a scoped TLS fallback fetch", async () => {
    const { sendMessageSignalTs } = await import("./signal-ts-runtime.js");
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-signal-upload-"));
    const mediaPath = path.join(tempDir, "captcha.png");
    await writeFile(mediaPath, new Uint8Array([1, 2, 3, 4]));
    const normalFetch = vi.fn(async () => {
      throw new Error("fetch failed");
    });
    vi.stubGlobal("fetch", normalFetch);
    mocks.signalCdnFetch.mockResolvedValueOnce(new Response(null, { status: 200 }));
    mocks.uploadAttachment.mockImplementationOnce(async (...args: unknown[]) => {
      const params = args[0] as { fetch?: typeof fetch };
      const response = await params.fetch?.("https://upload.signal.example/start", {
        method: "PUT",
      });
      expect(response?.ok).toBe(true);
      return { pointer: { cdnKey: "uploaded-key", cdnNumber: 2 } };
    });

    try {
      await sendMessageSignalTs({
        cfg: {},
        accountInfo: createSignalTsAccountInfo(),
        to: "signal:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        message: "reply",
        attachments: [{ path: mediaPath, contentType: "image/png" }],
      });

      expect(mocks.uploadAttachment).toHaveBeenCalledOnce();
      expect(normalFetch).toHaveBeenCalledOnce();
      expect(mocks.signalCdnFetch).toHaveBeenCalledOnce();
      expect(mocks.signalCdnFetch.mock.calls[0]?.[1]).toMatchObject({
        method: "PUT",
        dispatcher: expect.any(Object),
      });
      expect(mocks.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          attachments: [expect.objectContaining({ cdnKey: "uploaded-key" })],
        }),
      );
    } finally {
      vi.unstubAllGlobals();
      await rm(tempDir, { force: true, recursive: true });
    }
  });

  it("attaches Signal quote metadata for direct signal-ts replies", async () => {
    const { sendMessageSignalTs } = await import("./signal-ts-runtime.js");

    await sendMessageSignalTs({
      cfg: {},
      accountInfo: createSignalTsAccountInfo(),
      to: "signal:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      message: "reply",
      replyToId: "1700000000000",
    });

    expect(mocks.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        quote: {
          id: 1700000000000,
          authorAci: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        },
      }),
    );
  });

  it("sends direct reactions through signal-ts", async () => {
    const { sendReactionSignalTs } = await import("./signal-ts-runtime.js");

    const result = await sendReactionSignalTs({
      accountInfo: createSignalTsAccountInfo(),
      to: "signal:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      targetTimestamp: 1700000000000,
      emoji: "🔥",
    });

    expect(result).toEqual({ messageId: "765", timestamp: 765 });
    expect(mocks.sendReactionMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        destination: "signal:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        reaction: {
          emoji: "🔥",
          targetAuthorAci: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          targetSentTimestamp: 1700000000000,
        },
      }),
    );
  });

  it("sends group reactions through signal-ts group state", async () => {
    const { sendReactionSignalTs } = await import("./signal-ts-runtime.js");
    mocks.openRepository.mockResolvedValueOnce({
      getAccount: vi.fn(async () => ({
        account: {
          device: {
            aci: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            deviceId: 2,
          },
        },
      })),
      getGroup: vi.fn(async () => ({
        id: "group-id",
        masterKey: Buffer.from([1, 2, 3]).toString("base64"),
        distributionId: "44444444-4444-4444-8444-444444444444",
        members: ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"],
      })),
      getRecipientByAci: vi.fn(async () => undefined),
      getRecipientByE164: vi.fn(async () => undefined),
      setRecipient: vi.fn(async () => undefined),
    });

    const result = await sendReactionSignalTs({
      accountInfo: createSignalTsAccountInfo(),
      to: "signal:group:group-id",
      groupId: "group-id",
      targetAuthorUuid: "uuid:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      targetTimestamp: 1700000000000,
      emoji: "❌",
      remove: true,
    });

    expect(result).toEqual({ messageId: "876", timestamp: 876 });
    expect(mocks.sendGroupReactionMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        members: ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"],
        reaction: {
          emoji: "❌",
          remove: true,
          targetAuthorAci: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          targetSentTimestamp: 1700000000000,
        },
      }),
    );
  });

  it("uploads and sends migrated sticker files through signal-ts", async () => {
    const { sendStickerSignalTs } = await import("./signal-ts-runtime.js");
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-signal-sticker-"));
    const stickerPath = path.join(tempDir, "5");
    await writeFile(stickerPath, new Uint8Array([1, 2, 3]));
    const repository = {
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
      getRecipientByAci: vi.fn(async () => undefined),
      getRecipientByE164: vi.fn(async () => undefined),
      getStickerPack: vi.fn(async () => ({
        id: "aabbccdd",
        key: Buffer.from([9, 8, 7]).toString("base64"),
        installed: true,
        stickers: {
          "5": {
            id: 5,
            fileName: "5",
            emoji: "x",
            contentType: "image/webp",
          },
        },
      })),
      getStickerFilePath: vi.fn(() => stickerPath),
      setRecipient: vi.fn(async () => undefined),
    };
    mocks.openRepository.mockResolvedValueOnce(repository);
    mocks.uploadAttachment.mockResolvedValueOnce({
      pointer: { cdnKey: "sticker-cdn", cdnNumber: 3, contentType: "image/webp" },
    });

    try {
      const result = await sendStickerSignalTs({
        accountInfo: createSignalTsAccountInfo(),
        to: "signal:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        sticker: "aabbccdd:5",
      });

      expect(result).toEqual({ messageId: "321", timestamp: 321 });
      expect(mocks.uploadAttachment).toHaveBeenCalledWith(
        expect.objectContaining({
          attachment: expect.objectContaining({
            data: new Uint8Array([1, 2, 3]),
            contentType: "image/webp",
          }),
        }),
      );
      expect(mocks.sendStickerMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          destination: "signal:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          sticker: {
            packId: new Uint8Array([0xaa, 0xbb, 0xcc, 0xdd]),
            packKey: new Uint8Array([9, 8, 7]),
            stickerId: 5,
            emoji: "x",
            data: { cdnKey: "sticker-cdn", cdnNumber: 3, contentType: "image/webp" },
          },
        }),
      );
    } finally {
      await rm(tempDir, { force: true, recursive: true });
    }
  });

  it("sends migrated stickers to signal-ts groups", async () => {
    const { sendStickerSignalTs } = await import("./signal-ts-runtime.js");
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-signal-group-sticker-"));
    const stickerPath = path.join(tempDir, "5");
    await writeFile(stickerPath, new Uint8Array([1, 2, 3]));
    mocks.openRepository.mockResolvedValueOnce({
      getAccount: vi.fn(async () => ({
        account: {
          device: {
            aci: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            deviceId: 2,
          },
        },
      })),
      getGroup: vi.fn(async () => ({
        id: "group-id",
        masterKey: Buffer.from([1, 2, 3]).toString("base64"),
        distributionId: "44444444-4444-4444-8444-444444444444",
        members: ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"],
      })),
      getRecipientByAci: vi.fn(async () => undefined),
      getRecipientByE164: vi.fn(async () => undefined),
      getStickerPack: vi.fn(async () => ({
        id: "aabbccdd",
        key: Buffer.from([9, 8, 7]).toString("base64"),
        installed: true,
        stickers: { "5": { id: 5, fileName: "5" } },
      })),
      getStickerFilePath: vi.fn(() => stickerPath),
      setRecipient: vi.fn(async () => undefined),
    });
    mocks.uploadAttachment.mockResolvedValueOnce({
      pointer: { cdnKey: "group-sticker-cdn", cdnNumber: 3 },
    });

    try {
      const result = await sendStickerSignalTs({
        accountInfo: createSignalTsAccountInfo(),
        to: "signal:group:group-id",
        sticker: "aabbccdd:5",
      });

      expect(result).toEqual({ messageId: "654", timestamp: 654 });
      expect(mocks.sendGroupStickerMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          members: ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"],
          sticker: expect.objectContaining({
            stickerId: 5,
            data: { cdnKey: "group-sticker-cdn", cdnNumber: 3 },
          }),
        }),
      );
    } finally {
      await rm(tempDir, { force: true, recursive: true });
    }
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

  it("passes inbound signal-ts stickers through the signal-cli compatible envelope", async () => {
    const { monitorSignalTsProvider } = await import("./signal-ts-runtime.js");
    const abortController = new AbortController();
    mocks.abortController = abortController;
    mocks.emitIncomingOnFirstConnect = true;
    mocks.normalizeDecryptedIncomingMessage.mockReturnValue([
      {
        ...createSignalTsIncomingMessage(),
        message: {
          sticker: {
            packId: new Uint8Array([0xaa, 0xbb]),
            packKey: new Uint8Array([0xcc, 0xdd]),
            stickerId: 5,
          },
        },
      },
    ]);
    const onEvent = vi.fn(async (_event: { event: "receive"; data: string }) => undefined);

    await monitorSignalTsProvider({
      accountInfo: createSignalTsAccountInfo(),
      abortSignal: abortController.signal,
      reconnectPolicy: {
        initialMs: 1,
        maxMs: 1,
        factor: 1,
        jitter: 0,
      },
      runtime: {
        error: vi.fn(),
        exit: vi.fn(),
        log: vi.fn(),
      },
      onEvent,
    });

    const payload = JSON.parse(onEvent.mock.calls[0][0].data);
    expect(payload.envelope.dataMessage.sticker).toEqual({
      packId: Buffer.from([0xaa, 0xbb]).toString("base64"),
      packKey: Buffer.from([0xcc, 0xdd]).toString("base64"),
      stickerId: 5,
    });
  });

  it("sends connected-elsewhere as a channel error without synthesizing an inbound message", async () => {
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

    expect(mocks.connectCount).toBe(2);
    expect(mocks.computeBackoff).not.toHaveBeenCalled();
    expect(mocks.sleepWithAbort).not.toHaveBeenCalled();
    expect(runtime.error).toHaveBeenCalledWith(expect.stringContaining("signal-ts monitor fatal"));
    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(mocks.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        destination: "signal:uuid:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        body: expect.stringContaining("[OpenClaw channel error]"),
      }),
    );
    expect(mocks.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.stringContaining("ConnectedElsewhere"),
      }),
    );
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
