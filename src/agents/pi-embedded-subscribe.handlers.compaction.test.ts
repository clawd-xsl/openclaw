import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { handleAutoCompactionEnd } from "./pi-embedded-subscribe.handlers.compaction.js";
import type { EmbeddedPiSubscribeContext } from "./pi-embedded-subscribe.handlers.types.js";

vi.mock("../infra/agent-events.js", () => ({
  emitAgentEvent: vi.fn(),
}));

vi.mock("../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: vi.fn(() => undefined),
}));

function createContext(params: {
  workspaceDir: string;
  baseMessages: unknown[];
  onAgentEvent?: ReturnType<typeof vi.fn>;
}) {
  const replaceMessages = vi.fn();
  const appendedMessages: unknown[] = [];
  const appendMessage = vi.fn((message: unknown) => {
    appendedMessages.push(message);
  });
  const buildSessionContext = vi.fn(() => ({
    messages: [...params.baseMessages, ...appendedMessages],
  }));
  const incrementCompactionCount = vi.fn();
  const noteCompactionRetry = vi.fn();
  const resetForCompactionRetry = vi.fn();

  const ctx = {
    params: {
      runId: "run-1",
      sessionId: "session-1",
      session: {
        messages: params.baseMessages,
        sessionFile: "/tmp/session.jsonl",
        agent: {
          replaceMessages,
        },
      },
      sessionManager: {
        appendMessage,
        buildSessionContext,
      },
      workspaceDir: params.workspaceDir,
      onAgentEvent: params.onAgentEvent,
    },
    state: {
      compactionInFlight: true,
    },
    log: {
      debug: vi.fn(),
      warn: vi.fn(),
    },
    noteCompactionRetry,
    resetForCompactionRetry,
    maybeResolveCompactionWait: vi.fn(),
    incrementCompactionCount,
    ensureCompactionPromise: vi.fn(),
    resolveCompactionRetry: vi.fn(),
    getCompactionCount: vi.fn(() => 1),
  } as unknown as EmbeddedPiSubscribeContext;

  return {
    ctx,
    appendedMessages,
    replaceMessages,
    appendMessage,
    buildSessionContext,
    incrementCompactionCount,
    noteCompactionRetry,
    resetForCompactionRetry,
  };
}

describe("handleAutoCompactionEnd", () => {
  let tempDir: string | undefined;

  afterEach(() => {
    if (tempDir) {
      fs.rmSync(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  it("persists the COMPACTION.md recovery marker and keeps it after retained messages", () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-compaction-recovery-"));
    fs.writeFileSync(
      path.join(tempDir, "COMPACTION.md"),
      "Recover your state from the retained messages above.",
      "utf-8",
    );

    const retainedMessages = [
      { role: "compactionSummary", summary: "summary", timestamp: 1 },
      { role: "user", content: "retained", timestamp: 2 },
      {
        role: "assistant",
        stopReason: "error",
        content: [{ type: "text", text: "overflow" }],
        timestamp: 3,
      },
    ];

    const {
      ctx,
      appendedMessages,
      appendMessage,
      replaceMessages,
      buildSessionContext,
      incrementCompactionCount,
      noteCompactionRetry,
      resetForCompactionRetry,
    } = createContext({
      workspaceDir: tempDir,
      baseMessages: retainedMessages,
      onAgentEvent: vi.fn(),
    });

    handleAutoCompactionEnd(ctx, {
      type: "auto_compaction_end",
      result: { summary: "summary" },
      aborted: false,
      willRetry: true,
    });

    expect(appendMessage).toHaveBeenCalledTimes(1);
    expect(appendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        role: "custom",
        customType: "compaction-recovery",
        display: false,
        content: expect.stringContaining(
          "2. Retained messages - the most recent messages preserved during compaction",
        ),
      }),
    );
    expect(appendMessage.mock.calls[0]?.[0]).toMatchObject({
      content: expect.stringContaining("Recover your state from the retained messages above."),
    });
    expect(buildSessionContext).toHaveBeenCalledTimes(1);
    expect(replaceMessages).toHaveBeenCalledWith([
      retainedMessages[0],
      retainedMessages[1],
      appendedMessages[0],
    ]);
    expect(incrementCompactionCount).toHaveBeenCalledTimes(1);
    expect(noteCompactionRetry).toHaveBeenCalledTimes(1);
    expect(resetForCompactionRetry).toHaveBeenCalledTimes(1);
  });
});
