import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "../../config/sessions.js";
import {
  resetReplyRunSession,
  setAgentRunnerSessionResetTestDeps,
} from "./agent-runner-session-reset.js";
import type { FollowupRun } from "./queue.js";

const refreshQueuedFollowupSessionMock = vi.fn();
const errorMock = vi.fn();
const archiveStableSessionTranscriptMock = vi.fn();
const generateSessionSummaryMock = vi.fn();
const loadRecentSummariesMock = vi.fn();
const buildSessionHistorySectionMock = vi.fn();
const disposeSessionMcpRuntimeMock = vi.fn();
const resetRegisteredAgentHarnessSessionsMock = vi.fn();
const clearBootstrapSnapshotOnSessionRolloverMock = vi.fn();
const hookHasHooksMock = vi.fn();
const runSessionEndMock = vi.fn();
const runSessionStartMock = vi.fn();
const ensureSessionHeaderMock = vi.fn();

function createFollowupRun(): FollowupRun {
  return {
    prompt: "hello",
    summaryLine: "hello",
    enqueuedAt: Date.now(),
    run: {
      sessionId: "session",
      sessionKey: "main",
      agentId: "main",
      messageProvider: "whatsapp",
      sessionFile: "/tmp/session.jsonl",
      workspaceDir: "/tmp",
      config: {},
      skillsSnapshot: {},
      provider: "anthropic",
      model: "claude",
      thinkLevel: "low",
      verboseLevel: "off",
      elevatedLevel: "off",
      bashElevated: { enabled: false, allowed: false, defaultLevel: "off" },
      timeoutMs: 1_000,
      blockReplyBreak: "message_end",
    },
  } as unknown as FollowupRun;
}

async function writeSessionStore(
  storePath: string,
  sessionKey: string,
  entry: SessionEntry,
): Promise<void> {
  await fs.mkdir(path.dirname(storePath), { recursive: true });
  await fs.writeFile(storePath, JSON.stringify({ [sessionKey]: entry }, null, 2), "utf8");
}

describe("resetReplyRunSession", () => {
  let rootDir = "";

  beforeEach(async () => {
    rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-reset-run-"));
    refreshQueuedFollowupSessionMock.mockReset();
    errorMock.mockReset();
    archiveStableSessionTranscriptMock.mockReset();
    archiveStableSessionTranscriptMock.mockResolvedValue({
      sessionFile: path.join(rootDir, "archived-session.jsonl"),
      transcriptArchived: true,
    });
    generateSessionSummaryMock.mockReset();
    generateSessionSummaryMock.mockResolvedValue(undefined);
    loadRecentSummariesMock.mockReset();
    loadRecentSummariesMock.mockReturnValue([]);
    buildSessionHistorySectionMock.mockReset();
    buildSessionHistorySectionMock.mockReturnValue("");
    disposeSessionMcpRuntimeMock.mockReset();
    disposeSessionMcpRuntimeMock.mockResolvedValue(undefined);
    resetRegisteredAgentHarnessSessionsMock.mockReset();
    resetRegisteredAgentHarnessSessionsMock.mockResolvedValue(undefined);
    clearBootstrapSnapshotOnSessionRolloverMock.mockReset();
    hookHasHooksMock.mockReset();
    hookHasHooksMock.mockReturnValue(false);
    runSessionEndMock.mockReset();
    runSessionEndMock.mockResolvedValue(undefined);
    runSessionStartMock.mockReset();
    runSessionStartMock.mockResolvedValue(undefined);
    ensureSessionHeaderMock.mockReset();
    ensureSessionHeaderMock.mockResolvedValue(undefined);
    setAgentRunnerSessionResetTestDeps({
      generateSecureUuid: () => "00000000-0000-0000-0000-000000000123",
      refreshQueuedFollowupSession: refreshQueuedFollowupSessionMock as never,
      now: () => 1_713_000_000_000,
      archiveStableSessionTranscript: archiveStableSessionTranscriptMock as unknown as (
        params: unknown,
      ) => Promise<{ sessionFile?: string; transcriptArchived?: boolean }>,
      generateSessionSummary:
        generateSessionSummaryMock as unknown as typeof generateSessionSummaryMock,
      loadRecentSummaries: loadRecentSummariesMock as unknown as typeof loadRecentSummariesMock,
      buildSessionHistorySection:
        buildSessionHistorySectionMock as unknown as typeof buildSessionHistorySectionMock,
      disposeSessionMcpRuntime: disposeSessionMcpRuntimeMock as unknown as (
        sessionId: string,
      ) => Promise<void>,
      resetRegisteredAgentHarnessSessions: resetRegisteredAgentHarnessSessionsMock as unknown as (
        params: unknown,
      ) => Promise<void>,
      clearBootstrapSnapshotOnSessionRollover:
        clearBootstrapSnapshotOnSessionRolloverMock as unknown as (params: unknown) => void,
      getHookRunner: () => ({
        hasHooks: hookHasHooksMock,
        runSessionEnd: runSessionEndMock,
        runSessionStart: runSessionStartMock,
      }),
      ensureSessionHeader: ensureSessionHeaderMock as unknown as (params: {
        sessionFile: string;
        sessionId: string;
      }) => Promise<void>,
      error: errorMock,
      warn: errorMock,
    });
  });

  afterEach(async () => {
    setAgentRunnerSessionResetTestDeps();
    await fs.rm(rootDir, { recursive: true, force: true });
  });

  it("rotates the session and clears stale runtime and fallback fields", async () => {
    const storePath = path.join(rootDir, "sessions.json");
    const sessionEntry: SessionEntry = {
      sessionId: "session",
      updatedAt: 1,
      sessionFile: path.join(rootDir, "session.jsonl"),
      modelProvider: "qwencode",
      model: "qwen",
      contextTokens: 123,
      fallbackNoticeSelectedModel: "anthropic/claude",
      fallbackNoticeActiveModel: "openai/gpt",
      fallbackNoticeReason: "rate limit",
      systemPromptReport: {
        source: "run",
        generatedAt: 1,
        systemPrompt: { chars: 1, projectContextChars: 0, nonProjectContextChars: 1 },
        injectedWorkspaceFiles: [],
        skills: { promptChars: 0, entries: [] },
        tools: { listChars: 0, schemaChars: 0, entries: [] },
      },
    };
    const sessionStore = { main: sessionEntry };
    const followupRun = createFollowupRun();
    await writeSessionStore(storePath, "main", sessionEntry);

    let activeSessionEntry: SessionEntry | undefined = sessionEntry;
    let isNewSession = false;
    const reset = await resetReplyRunSession({
      options: {
        failureLabel: "compaction failure",
        buildLogMessage: (next) => `reset ${next}`,
      },
      sessionKey: "main",
      queueKey: "main",
      activeSessionEntry,
      activeSessionStore: sessionStore,
      storePath,
      followupRun,
      onActiveSessionEntry: (entry) => {
        activeSessionEntry = entry;
      },
      onNewSession: () => {
        isNewSession = true;
      },
    });

    expect(reset).toBe(true);
    expect(isNewSession).toBe(true);
    expect(activeSessionEntry?.sessionId).toBe("00000000-0000-0000-0000-000000000123");
    expect(followupRun.run.sessionId).toBe(activeSessionEntry?.sessionId);
    expect(activeSessionEntry?.modelProvider).toBeUndefined();
    expect(activeSessionEntry?.model).toBeUndefined();
    expect(activeSessionEntry?.contextTokens).toBeUndefined();
    expect(activeSessionEntry?.fallbackNoticeSelectedModel).toBeUndefined();
    expect(activeSessionEntry?.fallbackNoticeActiveModel).toBeUndefined();
    expect(activeSessionEntry?.fallbackNoticeReason).toBeUndefined();
    expect(activeSessionEntry?.systemPromptReport).toBeUndefined();
    expect(refreshQueuedFollowupSessionMock).toHaveBeenCalledWith({
      key: "main",
      previousSessionId: "session",
      nextSessionId: activeSessionEntry?.sessionId,
      nextSessionFile: activeSessionEntry?.sessionFile,
    });
    expect(errorMock).toHaveBeenCalledWith("reset 00000000-0000-0000-0000-000000000123");

    const persisted = JSON.parse(await fs.readFile(storePath, "utf8")) as {
      main: SessionEntry;
    };
    expect(persisted.main.sessionId).toBe(activeSessionEntry?.sessionId);
    expect(persisted.main.fallbackNoticeReason).toBeUndefined();
  });

  it("cleans up the old transcript when requested", async () => {
    const storePath = path.join(rootDir, "sessions.json");
    const oldTranscriptPath = path.join(rootDir, "old-session.jsonl");
    await fs.writeFile(oldTranscriptPath, "old", "utf8");
    const sessionEntry: SessionEntry = {
      sessionId: "old-session",
      updatedAt: 1,
      sessionFile: oldTranscriptPath,
    };
    const sessionStore = { main: sessionEntry };
    await writeSessionStore(storePath, "main", sessionEntry);

    await resetReplyRunSession({
      options: {
        failureLabel: "role ordering conflict",
        cleanupTranscripts: true,
        buildLogMessage: (next) => `reset ${next}`,
      },
      sessionKey: "main",
      queueKey: "main",
      activeSessionEntry: sessionEntry,
      activeSessionStore: sessionStore,
      storePath,
      followupRun: createFollowupRun(),
      onActiveSessionEntry: () => {},
      onNewSession: () => {},
    });

    await expect(fs.access(oldTranscriptPath)).rejects.toThrow();
  });

  it("promotes continuity resets into a full session rollover", async () => {
    ensureSessionHeaderMock.mockImplementation(
      async ({ sessionFile, sessionId }: { sessionFile: string; sessionId: string }) => {
        await fs.mkdir(path.dirname(sessionFile), { recursive: true });
        await fs.writeFile(
          sessionFile,
          `${JSON.stringify({ type: "session", id: sessionId, version: 2 })}\n`,
          "utf8",
        );
      },
    );
    hookHasHooksMock.mockImplementation(
      (name: string) => name === "session_end" || name === "session_start",
    );
    loadRecentSummariesMock.mockReturnValue([
      {
        session_id: "old-session",
        previous_session_id: "older-session",
        session_key: "main",
        agent_id: "main",
        created_at: 10,
        ended_at: 20,
        message_count: 5,
        summary: "summary",
        model: "claude",
        summary_model: "claude-cli/claude-sonnet-4-6",
        generated_at: 30,
      },
    ]);
    buildSessionHistorySectionMock.mockReturnValue("## Recent Session History\nsummary");

    const storePath = path.join(rootDir, "sessions.json");
    const sessionEntry: SessionEntry = {
      sessionId: "old-session",
      previousSessionId: "older-session",
      createdAt: 1_712_000_000_000,
      updatedAt: 1,
      sessionFile: path.join(rootDir, "old-session.jsonl"),
      compactionCount: 3,
      claudeCliSessionId: "thread-123",
      cliSessionIds: { "claude-cli": "thread-123" },
      cliSessionBindings: {
        "claude-cli": {
          sessionId: "thread-123",
          mcpConfigHash: "mcp-a",
        },
      },
      model: "claude-sonnet-4-6",
      modelOverride: "claude-sonnet-4-6",
    };
    const sessionStore = { main: sessionEntry };
    await writeSessionStore(storePath, "main", sessionEntry);
    const followupRun = createFollowupRun();
    let activeSessionEntry: SessionEntry | undefined = sessionEntry;
    const expectedNextSessionFile = path.join(
      rootDir,
      "00000000-0000-0000-0000-000000000123.jsonl",
    );

    const reset = await resetReplyRunSession({
      options: {
        failureLabel: "CLI session continuity break",
        buildLogMessage: (next) => `reset ${next}`,
        promoteToSessionRollover: true,
        rolloverReason: "unknown",
      },
      sessionKey: "main",
      queueKey: "main",
      activeSessionEntry,
      activeSessionStore: sessionStore,
      storePath,
      followupRun,
      onActiveSessionEntry: (entry) => {
        activeSessionEntry = entry;
      },
      onNewSession: () => {},
    });

    expect(reset).toBe(true);
    expect(activeSessionEntry?.sessionId).toBe("00000000-0000-0000-0000-000000000123");
    expect(activeSessionEntry?.sessionFile).toBe(expectedNextSessionFile);
    expect(activeSessionEntry?.previousSessionId).toBe("old-session");
    expect(activeSessionEntry?.createdAt).toBe(1_713_000_000_000);
    expect(activeSessionEntry?.compactionCount).toBe(0);
    expect(activeSessionEntry?.claudeCliSessionId).toBeUndefined();
    expect(activeSessionEntry?.cliSessionIds).toBeUndefined();
    expect(activeSessionEntry?.cliSessionBindings).toBeUndefined();
    expect(followupRun.run.sessionId).toBe("00000000-0000-0000-0000-000000000123");
    expect(followupRun.run.previousSessionId).toBe("old-session");
    expect(followupRun.run.sessionCreatedAt).toBe(1_713_000_000_000);
    expect(followupRun.run.recentSessionHistory).toBe("## Recent Session History\nsummary");
    expect(clearBootstrapSnapshotOnSessionRolloverMock).toHaveBeenCalledWith({
      sessionKey: "main",
      previousSessionId: "old-session",
    });
    expect(archiveStableSessionTranscriptMock).toHaveBeenCalledWith({
      sessionId: "old-session",
      storePath,
      sessionFile: sessionEntry.sessionFile,
      agentId: "main",
    });
    expect(generateSessionSummaryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "old-session",
        previousSessionId: "older-session",
        sessionKey: "main",
        agentId: "main",
        createdAt: 1_712_000_000_000,
        endedAt: 1_713_000_000_000,
      }),
    );
    expect(loadRecentSummariesMock).toHaveBeenCalledWith({
      sessionKey: "main",
      agentId: "main",
      config: followupRun.run.config,
    });
    expect(disposeSessionMcpRuntimeMock).toHaveBeenCalledWith("old-session");
    expect(resetRegisteredAgentHarnessSessionsMock).toHaveBeenCalledWith({
      sessionId: "old-session",
      sessionKey: "main",
      sessionFile: sessionEntry.sessionFile,
      reason: "unknown",
    });
    expect(refreshQueuedFollowupSessionMock).toHaveBeenCalledWith({
      key: "main",
      previousSessionId: "old-session",
      nextSessionId: "00000000-0000-0000-0000-000000000123",
      nextSessionFile: activeSessionEntry?.sessionFile,
      nextPreviousSessionId: "old-session",
      nextRecentSessionHistory: "## Recent Session History\nsummary",
      nextSessionCreatedAt: 1_713_000_000_000,
    });
    expect(runSessionEndMock).toHaveBeenCalledTimes(1);
    expect(runSessionStartMock).toHaveBeenCalledTimes(1);
    expect(ensureSessionHeaderMock).toHaveBeenCalledWith({
      sessionFile: expectedNextSessionFile,
      sessionId: "00000000-0000-0000-0000-000000000123",
    });
    await expect(fs.readFile(expectedNextSessionFile, "utf8")).resolves.toContain(
      '"id":"00000000-0000-0000-0000-000000000123"',
    );
  });
});
