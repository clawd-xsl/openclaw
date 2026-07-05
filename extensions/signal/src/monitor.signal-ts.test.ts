import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  eventHandler: vi.fn(async () => undefined),
  eventHandlerDeps: undefined as
    | {
        fetchAttachment: (params: {
          attachment: { id?: string | null };
          maxBytes: number;
        }) => Promise<unknown>;
      }
    | undefined,
  fetchAttachment: vi.fn(async (_params: unknown) => ({
    path: "/tmp/signal-ts-attachment",
    contentType: "image/png",
  })),
  monitor: vi.fn(async (_params: unknown) => undefined),
  runSseLoop: vi.fn(async (_params: unknown) => undefined),
  spawnDaemon: vi.fn((_params: unknown) => undefined),
}));

vi.mock("./monitor/event-handler.js", () => ({
  createSignalEventHandler: (deps: typeof mocks.eventHandlerDeps) => {
    mocks.eventHandlerDeps = deps;
    return mocks.eventHandler;
  },
}));

vi.mock("./signal-ts-runtime.js", () => ({
  fetchSignalTsAttachment: (params: unknown) => mocks.fetchAttachment(params),
  monitorSignalTsProvider: (params: unknown) => mocks.monitor(params),
}));

vi.mock("./sse-reconnect.js", () => ({
  runSignalSseLoop: (params: unknown) => mocks.runSseLoop(params),
}));

vi.mock("./daemon.js", () => ({
  formatSignalDaemonExit: vi.fn(),
  spawnSignalDaemon: (params: unknown) => mocks.spawnDaemon(params),
}));

const { monitorSignalProvider } = await import("./monitor.js");

describe("monitorSignalProvider signal-ts transport", () => {
  beforeEach(() => {
    mocks.eventHandler.mockClear();
    mocks.eventHandlerDeps = undefined;
    mocks.fetchAttachment.mockClear();
    mocks.runSseLoop.mockClear();
    mocks.spawnDaemon.mockClear();
    mocks.monitor.mockReset().mockImplementation(async (value: unknown) => {
      const params = value as {
        onEvent: (event: { event: "receive"; data: string }) => Promise<void>;
      };
      await params.onEvent({ event: "receive", data: "{}" });
    });
  });

  it("uses the embedded monitor and attachment decryptor without starting signal-cli", async () => {
    const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };

    await monitorSignalProvider({
      config: {
        channels: {
          signal: {
            backend: "signal-ts",
            signalTsStatePath: "/secure/signal/default.json",
          },
        },
      } as never,
      runtime,
    });

    expect(mocks.monitor).toHaveBeenCalledWith(
      expect.objectContaining({
        accountInfo: expect.objectContaining({ accountId: "default" }),
        runtime,
      }),
    );
    expect(mocks.eventHandler).toHaveBeenCalledWith({ event: "receive", data: "{}" });
    expect(mocks.spawnDaemon).not.toHaveBeenCalled();
    expect(mocks.runSseLoop).not.toHaveBeenCalled();

    await mocks.eventHandlerDeps?.fetchAttachment({
      attachment: { id: "signal-ts:cdn-key" },
      maxBytes: 1024,
    });
    expect(mocks.fetchAttachment).toHaveBeenCalledWith(
      expect.objectContaining({
        accountInfo: expect.objectContaining({ accountId: "default" }),
        maxBytes: 1024,
        runtime,
      }),
    );
  });
});
