import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  drainSessionStoreLockQueuesForTest,
  resetSessionStoreLockRuntimeForTests,
  setSessionWriteLockAcquirerForTests,
} from "../config/sessions.js";
import {
  readCompactionCount,
  seedSessionStore,
  waitForCompactionCount,
} from "./pi-embedded-subscribe.compaction-test-helpers.js";
import {
  handleAutoCompactionEnd,
  reconcileSessionStoreCompactionCountAfterSuccess,
} from "./pi-embedded-subscribe.handlers.compaction.js";
import type { EmbeddedPiSubscribeContext } from "./pi-embedded-subscribe.handlers.types.js";

function createCompactionContext(params: {
  storePath: string;
  sessionKey: string;
  agentId?: string;
  initialCount: number;
  messages?: AgentMessage[];
  workspaceDir?: string;
}) {
  let compactionCount = params.initialCount;
  const appendedMessages: AgentMessage[] = [];
  const agentState = {
    messages: [...(params.messages ?? [])],
  };
  const session = {
    sessionFile: "/tmp/session.jsonl",
    agent: {
      state: agentState,
    },
    get messages() {
      return agentState.messages;
    },
  };
  const sessionManager = {
    appendMessage: vi.fn((message: AgentMessage) => {
      appendedMessages.push(message);
    }),
    buildSessionContext: vi.fn(() => ({
      messages: [...agentState.messages, ...appendedMessages],
    })),
    getCwd: vi.fn(() => params.workspaceDir ?? ""),
  };
  const noteCompactionRetry = vi.fn();
  const resetForCompactionRetry = vi.fn();
  const maybeResolveCompactionWait = vi.fn();
  const ensureCompactionPromise = vi.fn();
  const resolveCompactionRetry = vi.fn();

  return {
    ctx: {
      params: {
        runId: "run-test",
        session: session as never,
        config: { session: { store: params.storePath } } as never,
        sessionKey: params.sessionKey,
        sessionId: "session-1",
        agentId: params.agentId ?? "test-agent",
        onAgentEvent: undefined,
      },
      state: {
        compactionInFlight: true,
        pendingCompactionRetry: 0,
      } as never,
      log: {
        debug: vi.fn(),
        warn: vi.fn(),
      },
      ensureCompactionPromise,
      noteCompactionRetry,
      maybeResolveCompactionWait,
      resolveCompactionRetry,
      resetForCompactionRetry,
      incrementCompactionCount: () => {
        compactionCount += 1;
      },
      getCompactionCount: () => compactionCount,
    } as unknown as EmbeddedPiSubscribeContext,
    sessionManager,
    appendedMessages,
    agentState,
    noteCompactionRetry,
    resetForCompactionRetry,
    maybeResolveCompactionWait,
  };
}

beforeEach(() => {
  setSessionWriteLockAcquirerForTests(async () => ({
    release: async () => {},
  }));
});

afterEach(async () => {
  resetSessionStoreLockRuntimeForTests();
  await drainSessionStoreLockQueuesForTest();
});

describe("reconcileSessionStoreCompactionCountAfterSuccess", () => {
  it("raises the stored compaction count to the observed value", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-compaction-reconcile-"));
    const storePath = path.join(tmp, "sessions.json");
    const sessionKey = "main";
    await seedSessionStore({
      storePath,
      sessionKey,
      compactionCount: 1,
    });

    const nextCount = await reconcileSessionStoreCompactionCountAfterSuccess({
      sessionKey,
      agentId: "test-agent",
      configStore: storePath,
      observedCompactionCount: 2,
      now: 2_000,
    });

    expect(nextCount).toBe(2);
    expect(await readCompactionCount(storePath, sessionKey)).toBe(2);
  });

  it("does not double count when the store is already at or above the observed value", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-compaction-idempotent-"));
    const storePath = path.join(tmp, "sessions.json");
    const sessionKey = "main";
    await seedSessionStore({
      storePath,
      sessionKey,
      compactionCount: 3,
    });

    const nextCount = await reconcileSessionStoreCompactionCountAfterSuccess({
      sessionKey,
      agentId: "test-agent",
      configStore: storePath,
      observedCompactionCount: 2,
      now: 2_000,
    });

    expect(nextCount).toBe(3);
    expect(await readCompactionCount(storePath, sessionKey)).toBe(3);
  });
});

describe("handleAutoCompactionEnd", () => {
  it("reconciles the session store after a successful compaction end event", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-compaction-handler-"));
    const storePath = path.join(tmp, "sessions.json");
    const sessionKey = "main";
    await seedSessionStore({
      storePath,
      sessionKey,
      compactionCount: 1,
    });

    const { ctx } = createCompactionContext({
      storePath,
      sessionKey,
      initialCount: 1,
    });

    handleAutoCompactionEnd(ctx, {
      type: "auto_compaction_end",
      result: { kept: 12 },
      willRetry: false,
      aborted: false,
    } as never);

    await waitForCompactionCount({
      storePath,
      sessionKey,
      expected: 2,
    });

    expect(await readCompactionCount(storePath, sessionKey)).toBe(2);
  });

  it("persists a hidden recovery marker and strips trailing retry noise on auto-compaction retry", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-compaction-recovery-"));
    const storePath = path.join(tmp, "sessions.json");
    const sessionKey = "main";
    await seedSessionStore({
      storePath,
      sessionKey,
      compactionCount: 1,
    });
    await fs.writeFile(
      path.join(tmp, "COMPACTION.md"),
      "Recover your state from the retained messages above.",
      "utf-8",
    );

    const retainedMessages = [
      { role: "compactionSummary", summary: "summary", timestamp: 1 },
      { role: "user", content: "retained", timestamp: 2 },
      {
        role: "assistant",
        stopReason: "error",
        content: [{ type: "text", text: "context overflow" }],
        timestamp: 3,
      },
    ] as AgentMessage[];

    const {
      ctx,
      sessionManager,
      appendedMessages,
      agentState,
      noteCompactionRetry,
      resetForCompactionRetry,
      maybeResolveCompactionWait,
    } = createCompactionContext({
      storePath,
      sessionKey,
      initialCount: 1,
      messages: retainedMessages,
      workspaceDir: tmp,
    });
    delete (ctx.params as { workspaceDir?: string }).workspaceDir;
    delete (ctx.params as { sessionManager?: unknown }).sessionManager;
    (ctx.params.session as { sessionManager?: unknown }).sessionManager = sessionManager;

    handleAutoCompactionEnd(ctx, {
      type: "auto_compaction_end",
      result: { kept: 12 },
      willRetry: true,
      aborted: false,
    } as never);

    await waitForCompactionCount({
      storePath,
      sessionKey,
      expected: 2,
    });

    expect(sessionManager.appendMessage).toHaveBeenCalledTimes(1);
    expect(appendedMessages[0]).toMatchObject({
      role: "custom",
      customType: "compaction-recovery",
      display: false,
      content: expect.stringContaining("Recover your state from the retained messages above."),
    });
    expect(sessionManager.buildSessionContext).toHaveBeenCalledTimes(1);
    expect(agentState.messages).toEqual([
      retainedMessages[0],
      retainedMessages[1],
      appendedMessages[0],
    ]);
    expect(noteCompactionRetry).toHaveBeenCalledTimes(1);
    expect(resetForCompactionRetry).toHaveBeenCalledTimes(1);
    expect(maybeResolveCompactionWait).not.toHaveBeenCalled();
  });
});
