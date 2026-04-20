import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CURRENT_SESSION_VERSION } from "@mariozechner/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MsgContext } from "../../auto-reply/templating.js";
import { updateSessionStoreEntry } from "../../config/sessions.js";
import type { GatewayRequestContext } from "./types.js";

const mockState = vi.hoisted(() => ({
  sessionId: "sess-1",
  transcriptPath: "",
  eventOrder: [] as string[],
  lastDispatchCtx: undefined as MsgContext | undefined,
  deferTouch: false,
  releaseTouch: undefined as (() => void) | undefined,
}));

vi.mock("../session-utils.js", async () => {
  const original =
    await vi.importActual<typeof import("../session-utils.js")>("../session-utils.js");
  return {
    ...original,
    loadSessionEntry: (rawKey: string) => ({
      cfg: {},
      storePath: path.join(path.dirname(mockState.transcriptPath), "sessions.json"),
      entry: {
        sessionId: mockState.sessionId,
        sessionFile: mockState.transcriptPath,
        updatedAt: 1,
      },
      canonicalKey: rawKey || "main",
    }),
  };
});

vi.mock("../../config/sessions.js", async () => {
  const original = await vi.importActual<typeof import("../../config/sessions.js")>(
    "../../config/sessions.js",
  );
  return {
    ...original,
    resolveSessionFilePath: vi.fn((sessionId: string) =>
      path.join(path.dirname(mockState.transcriptPath), `${sessionId}.jsonl`),
    ),
    updateSessionStoreEntry: vi.fn(
      async ({
        update,
      }: {
        update: (entry: {
          sessionId: string;
          updatedAt: number;
        }) => Promise<{ updatedAt?: number } | null>;
      }) => {
        const patch = await update({ sessionId: mockState.sessionId, updatedAt: 1 });
        if (mockState.deferTouch) {
          await new Promise<void>((resolve) => {
            mockState.releaseTouch = () => {
              mockState.eventOrder.push("touch");
              resolve();
            };
          });
        } else {
          mockState.eventOrder.push("touch");
        }
        return patch ? { sessionId: mockState.sessionId, updatedAt: patch.updatedAt ?? 1 } : null;
      },
    ),
  };
});

vi.mock("../../auto-reply/dispatch.js", () => ({
  dispatchInboundMessage: vi.fn(
    async (params: {
      ctx: MsgContext;
      dispatcher: {
        sendFinalReply: (payload: { text?: string }) => boolean;
        markComplete: () => void;
        waitForIdle: () => Promise<void>;
      };
    }) => {
      mockState.eventOrder.push("dispatch");
      mockState.lastDispatchCtx = params.ctx;
      params.dispatcher.sendFinalReply({ text: "ok" });
      params.dispatcher.markComplete();
      await params.dispatcher.waitForIdle();
      return { ok: true };
    },
  ),
}));

vi.mock("../../sessions/transcript-events.js", () => ({
  emitSessionTranscriptUpdate: vi.fn(),
}));

const { chatHandlers } = await import("./chat.js");

function createTranscriptFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-chat-touch-session-"));
  const transcriptPath = path.join(dir, "sess.jsonl");
  fs.writeFileSync(
    transcriptPath,
    `${JSON.stringify({
      type: "session",
      version: CURRENT_SESSION_VERSION,
      id: mockState.sessionId,
      timestamp: new Date(0).toISOString(),
      cwd: "/tmp",
    })}\n`,
    "utf-8",
  );
  mockState.transcriptPath = transcriptPath;
  return dir;
}

function createChatContext(): Pick<
  GatewayRequestContext,
  | "broadcast"
  | "nodeSendToSession"
  | "agentRunSeq"
  | "chatAbortControllers"
  | "chatRunBuffers"
  | "chatDeltaSentAt"
  | "chatDeltaLastBroadcastLen"
  | "chatAbortedRuns"
  | "removeChatRun"
  | "dedupe"
  | "loadGatewayModelCatalog"
  | "registerToolEventRecipient"
  | "logGateway"
> {
  return {
    broadcast: vi.fn() as unknown as GatewayRequestContext["broadcast"],
    nodeSendToSession: vi.fn() as unknown as GatewayRequestContext["nodeSendToSession"],
    agentRunSeq: new Map<string, number>(),
    chatAbortControllers: new Map(),
    chatRunBuffers: new Map(),
    chatDeltaSentAt: new Map(),
    chatDeltaLastBroadcastLen: new Map(),
    chatAbortedRuns: new Map(),
    removeChatRun: vi.fn(),
    dedupe: new Map(),
    loadGatewayModelCatalog: async () => [],
    registerToolEventRecipient: vi.fn(),
    logGateway: {
      warn: vi.fn(),
      debug: vi.fn(),
    } as unknown as GatewayRequestContext["logGateway"],
  };
}

async function waitForAssertion(assertion: () => void, timeoutMs = 1000, stepMs = 2) {
  vi.useFakeTimers();
  try {
    let lastError: unknown;
    for (let elapsed = 0; elapsed <= timeoutMs; elapsed += stepMs) {
      try {
        assertion();
        return;
      } catch (error) {
        lastError = error;
      }
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(stepMs);
    }
    throw lastError ?? new Error("assertion did not pass in time");
  } finally {
    vi.useRealTimers();
  }
}

describe("chat.send session touch", () => {
  afterEach(() => {
    if (mockState.transcriptPath) {
      fs.rmSync(path.dirname(mockState.transcriptPath), { recursive: true, force: true });
    }
    mockState.transcriptPath = "";
    mockState.eventOrder = [];
    mockState.lastDispatchCtx = undefined;
    mockState.deferTouch = false;
    mockState.releaseTouch = undefined;
  });

  it("dispatches without scheduling a session touch", async () => {
    createTranscriptFixture();
    const context = createChatContext();

    const sendPromise = chatHandlers["chat.send"]({
      params: {
        sessionKey: "main",
        message: "hello",
        idempotencyKey: "idem-touch-session",
      },
      respond: vi.fn() as never,
      req: {} as never,
      client: null as never,
      isWebchatConnect: () => false,
      context: context as GatewayRequestContext,
    });

    await expect(sendPromise).resolves.toBeUndefined();

    await waitForAssertion(() => {
      expect(mockState.eventOrder).toEqual(["dispatch"]);
      expect(mockState.lastDispatchCtx?.Body).toBe("hello");
    });
    expect(vi.mocked(updateSessionStoreEntry)).not.toHaveBeenCalled();
  });
});
