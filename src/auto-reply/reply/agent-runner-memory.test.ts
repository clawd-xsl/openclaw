import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "../../config/sessions.js";
import {
  clearMemoryPluginState,
  registerMemoryFlushPlanResolver,
} from "../../plugins/memory-state.js";
import type { TemplateContext } from "../templating.js";
import {
  runMemoryFlushIfNeeded,
  runPreflightCompactionIfNeeded,
  setAgentRunnerMemoryTestDeps,
} from "./agent-runner-memory.js";
import type { FollowupRun } from "./queue.js";

const runWithModelFallbackMock = vi.fn();
const runEmbeddedPiAgentMock = vi.fn();
const runCliAgentMock = vi.fn();
const compactEmbeddedPiSessionMock = vi.fn();
const refreshQueuedFollowupSessionMock = vi.fn();
const incrementCompactionCountMock = vi.fn();
const updateSessionStoreEntryMock = vi.fn();
const ORIGINAL_HOME = process.env.HOME;

function createReplyOperation() {
  return {
    abortSignal: new AbortController().signal,
    setPhase: vi.fn(),
    updateSessionId: vi.fn(),
  } as never;
}

function createFollowupRun(overrides: Partial<FollowupRun["run"]> = {}): FollowupRun {
  return {
    prompt: "hello",
    summaryLine: "hello",
    enqueuedAt: Date.now(),
    run: {
      agentId: "main",
      agentDir: "/tmp/agent",
      sessionId: "session",
      sessionKey: "main",
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
      skipProviderRuntimeHints: true,
      ...overrides,
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

async function writeClaudeCliTranscript(params: {
  homeDir: string;
  cliSessionId: string;
  usage: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
}): Promise<string> {
  const projectDir = path.join(params.homeDir, ".claude", "projects", "test-workspace");
  const transcriptPath = path.join(projectDir, `${params.cliSessionId}.jsonl`);
  await fs.mkdir(projectDir, { recursive: true });
  await fs.writeFile(
    transcriptPath,
    [
      JSON.stringify({
        type: "assistant",
        sessionId: params.cliSessionId,
        timestamp: "2026-05-30T03:16:53.007Z",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "ok" }],
          usage: params.usage,
        },
      }),
    ].join("\n") + "\n",
    "utf8",
  );
  return transcriptPath;
}

describe("runMemoryFlushIfNeeded", () => {
  let rootDir = "";
  let homeDir = "";

  beforeEach(async () => {
    rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-memory-unit-"));
    homeDir = path.join(rootDir, "home");
    process.env.HOME = homeDir;
    registerMemoryFlushPlanResolver(() => ({
      softThresholdTokens: 4_000,
      forceFlushTranscriptBytes: 1_000_000_000,
      reserveTokensFloor: 20_000,
      prompt: "Pre-compaction memory flush.\nNO_REPLY",
      systemPrompt: "Write memory to memory/YYYY-MM-DD.md.",
      relativePath: "memory/2023-11-14.md",
    }));
    runWithModelFallbackMock.mockReset().mockImplementation(async ({ provider, model, run }) => ({
      result: await run(provider, model),
      provider,
      model,
      attempts: [],
    }));
    runEmbeddedPiAgentMock.mockReset().mockResolvedValue({ payloads: [], meta: {} });
    runCliAgentMock.mockReset().mockResolvedValue({
      payloads: [{ text: "Condensed earlier context." }],
      meta: {},
    });
    compactEmbeddedPiSessionMock.mockReset();
    refreshQueuedFollowupSessionMock.mockReset();
    incrementCompactionCountMock.mockReset().mockImplementation(async (params) => {
      const sessionKey = String(params.sessionKey ?? "");
      if (!sessionKey || !params.sessionStore?.[sessionKey]) {
        return undefined;
      }
      const previous = params.sessionStore[sessionKey] as SessionEntry;
      const nextEntry: SessionEntry = {
        ...previous,
        compactionCount: (previous.compactionCount ?? 0) + 1,
      };
      if (typeof params.newSessionId === "string" && params.newSessionId) {
        nextEntry.sessionId = params.newSessionId;
        const storePath = typeof params.storePath === "string" ? params.storePath : rootDir;
        nextEntry.sessionFile = path.join(path.dirname(storePath), `${params.newSessionId}.jsonl`);
      }
      params.sessionStore[sessionKey] = nextEntry;
      if (typeof params.storePath === "string") {
        await writeSessionStore(params.storePath, sessionKey, nextEntry);
      }
      return nextEntry.compactionCount;
    });
    updateSessionStoreEntryMock.mockReset().mockImplementation(async (params) => {
      const raw = await fs.readFile(params.storePath, "utf8");
      const store = JSON.parse(raw) as Record<string, SessionEntry>;
      const entry = store[params.sessionKey];
      if (!entry) {
        return null;
      }
      const patch = await params.update(entry);
      if (!patch) {
        return entry;
      }
      const nextEntry = {
        ...entry,
        ...patch,
      };
      store[params.sessionKey] = nextEntry;
      await writeSessionStore(params.storePath, params.sessionKey, nextEntry);
      return nextEntry;
    });
    setAgentRunnerMemoryTestDeps({
      runWithModelFallback: runWithModelFallbackMock as never,
      runEmbeddedPiAgent: runEmbeddedPiAgentMock as never,
      runCliAgent: runCliAgentMock as never,
      compactEmbeddedPiSession: compactEmbeddedPiSessionMock as never,
      refreshQueuedFollowupSession: refreshQueuedFollowupSessionMock as never,
      incrementCompactionCount: incrementCompactionCountMock as never,
      updateSessionStoreEntry: updateSessionStoreEntryMock as never,
      registerAgentRunContext: vi.fn() as never,
      randomUUID: () => "00000000-0000-0000-0000-000000000001",
      now: () => 1_700_000_000_000,
    });
  });

  afterEach(async () => {
    setAgentRunnerMemoryTestDeps();
    clearMemoryPluginState();
    if (ORIGINAL_HOME === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = ORIGINAL_HOME;
    }
    await fs.rm(rootDir, { recursive: true, force: true });
  });

  it("runs a memory flush turn, rotates after compaction, and persists metadata", async () => {
    const storePath = path.join(rootDir, "sessions.json");
    const sessionKey = "main";
    const sessionEntry: SessionEntry = {
      sessionId: "session",
      updatedAt: Date.now(),
      totalTokens: 80_000,
      totalTokensFresh: true,
      compactionCount: 1,
    };
    const sessionStore = { [sessionKey]: sessionEntry };
    await writeSessionStore(storePath, sessionKey, sessionEntry);

    runEmbeddedPiAgentMock.mockImplementationOnce(
      async (params: {
        onAgentEvent?: (evt: { stream: string; data: { phase: string } }) => void;
      }) => {
        params.onAgentEvent?.({ stream: "compaction", data: { phase: "end" } });
        return {
          payloads: [],
          meta: { agentMeta: { sessionId: "session-rotated" } },
        };
      },
    );

    const followupRun = createFollowupRun();
    const entry = await runMemoryFlushIfNeeded({
      cfg: {
        agents: {
          defaults: {
            compaction: {
              memoryFlush: {},
            },
          },
        },
      },
      followupRun,
      sessionCtx: { Provider: "whatsapp" } as unknown as TemplateContext,
      defaultModel: "anthropic/claude-opus-4-6",
      agentCfgContextTokens: 100_000,
      resolvedVerboseLevel: "off",
      sessionEntry,
      sessionStore,
      sessionKey,
      storePath,
      isHeartbeat: false,
      replyOperation: createReplyOperation(),
    });

    expect(entry?.sessionId).toBe("session-rotated");
    expect(followupRun.run.sessionId).toBe("session-rotated");
    expect(runEmbeddedPiAgentMock).toHaveBeenCalledTimes(1);
    const flushCall = runEmbeddedPiAgentMock.mock.calls[0]?.[0] as {
      prompt?: string;
      memoryFlushWritePath?: string;
      silentExpected?: boolean;
    };
    expect(flushCall.prompt).toContain("Pre-compaction memory flush.");
    expect(flushCall.memoryFlushWritePath).toMatch(/^memory\/\d{4}-\d{2}-\d{2}\.md$/);
    expect(flushCall.silentExpected).toBe(true);
    expect(refreshQueuedFollowupSessionMock).toHaveBeenCalledWith({
      key: sessionKey,
      previousSessionId: "session",
      nextSessionId: "session-rotated",
      nextSessionFile: expect.stringContaining("session-rotated.jsonl"),
    });

    const persisted = JSON.parse(await fs.readFile(storePath, "utf8")) as {
      main: SessionEntry;
    };
    expect(persisted.main.sessionId).toBe("session-rotated");
    expect(persisted.main.compactionCount).toBe(2);
    expect(persisted.main.memoryFlushCompactionCount).toBe(2);
    expect(persisted.main.memoryFlushAt).toBe(1_700_000_000_000);
    expect(persisted.main.memoryFlushPromptTokens).toBeGreaterThanOrEqual(80_000);
  });

  it("runs memory flush for CLI providers", async () => {
    const sessionEntry: SessionEntry = {
      sessionId: "session",
      updatedAt: Date.now(),
      totalTokens: 80_000,
      compactionCount: 1,
    };

    const entry = await runMemoryFlushIfNeeded({
      cfg: { agents: { defaults: { cliBackends: { "codex-cli": { command: "codex" } } } } },
      followupRun: createFollowupRun({ provider: "codex-cli", model: "gpt-5.4" }),
      sessionCtx: { Provider: "whatsapp" } as unknown as TemplateContext,
      defaultModel: "codex-cli/gpt-5.4",
      agentCfgContextTokens: 100_000,
      resolvedVerboseLevel: "off",
      sessionEntry,
      sessionStore: { main: sessionEntry },
      sessionKey: "main",
      isHeartbeat: false,
      replyOperation: createReplyOperation(),
    });

    expect(entry).toBe(sessionEntry);
    expect(runEmbeddedPiAgentMock).toHaveBeenCalledTimes(1);
    const flushCall = runEmbeddedPiAgentMock.mock.calls[0]?.[0] as {
      provider?: string;
      model?: string;
      prompt?: string;
      silentExpected?: boolean;
    };
    expect(flushCall.provider).toBe("codex-cli");
    expect(flushCall.model).toBe("gpt-5.4");
    expect(flushCall.prompt).toContain("Pre-compaction memory flush.");
    expect(flushCall.silentExpected).toBe(true);
  });

  it("compacts CLI sessions from Claude transcript usage into provider overlays and clears only the CLI binding", async () => {
    registerMemoryFlushPlanResolver(() => ({
      softThresholdTokens: 10,
      forceFlushTranscriptBytes: 1_000_000_000,
      reserveTokensFloor: 100,
      prompt: "Pre-compaction memory flush.\nNO_REPLY",
      systemPrompt: "Write memory to memory/YYYY-MM-DD.md.",
      relativePath: "memory/2023-11-14.md",
    }));
    const sessionDir = await fs.mkdtemp(path.join(rootDir, "openclaw-cli-preflight-"));
    const sessionFile = path.join(sessionDir, "session.jsonl");
    await fs.writeFile(
      sessionFile,
      [
        JSON.stringify({
          id: "m1",
          message: {
            role: "user",
            content: [{ type: "text", text: "older question ".repeat(80) }],
          },
        }),
        JSON.stringify({
          id: "m2",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "older answer ".repeat(80) }],
          },
        }),
        JSON.stringify({
          id: "m3",
          message: {
            role: "user",
            content: [{ type: "text", text: "current ask ".repeat(40) }],
          },
        }),
      ].join("\n") + "\n",
      "utf8",
    );

    const storePath = path.join(rootDir, "sessions.json");
    const sessionKey = "main";
    await writeClaudeCliTranscript({
      homeDir,
      cliSessionId: "cli-session-1",
      usage: {
        input_tokens: 120,
        cache_read_input_tokens: 240,
        output_tokens: 20,
      },
    });
    const sessionEntry: SessionEntry = {
      sessionId: "session",
      updatedAt: Date.now(),
      sessionFile,
      cliSessionIds: { "claude-cli": "cli-session-1" },
      cliSessionBindings: {
        "claude-cli": {
          sessionId: "cli-session-1",
          mcpConfigHash: "mcp-a",
        },
      },
    };
    const sessionStore = { [sessionKey]: sessionEntry };
    await writeSessionStore(storePath, sessionKey, sessionEntry);
    runCliAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "Condensed earlier context." }],
      meta: {},
    });

    const entry = await runPreflightCompactionIfNeeded({
      cfg: {
        agents: {
          defaults: {
            cliBackends: {
              "claude-cli": { command: "claude" },
            },
            compaction: {
              reserveTokensFloor: 100,
            },
          },
        },
      },
      followupRun: createFollowupRun({
        provider: "claude-cli",
        model: "sonnet",
        sessionFile,
      }),
      promptForEstimate: "current ask ".repeat(40),
      defaultModel: "claude-cli/sonnet",
      agentCfgContextTokens: 400,
      sessionEntry,
      sessionStore,
      sessionKey,
      storePath,
      isHeartbeat: false,
      replyOperation: createReplyOperation(),
    });

    expect(compactEmbeddedPiSessionMock).not.toHaveBeenCalled();
    expect(runCliAgentMock).toHaveBeenCalledTimes(1);
    const compactionCall = runCliAgentMock.mock.calls[0]?.[0] as {
      cliSessionId?: string;
      prompt?: string;
      sessionFile?: string;
      sessionId?: string;
    };
    expect(compactionCall.cliSessionId).toBeUndefined();
    expect(compactionCall.sessionId).not.toBe("session");
    expect(compactionCall.sessionFile).not.toBe(sessionFile);
    expect(compactionCall.prompt).toContain("[Claude Code session history]");
    expect(compactionCall.prompt).toContain("ok");
    expect(compactionCall.prompt).not.toContain("older question");
    expect(compactionCall.prompt).not.toContain("older answer");
    expect(entry?.cliSessionBindings).toBeUndefined();
    expect(entry?.cliSessionIds).toBeUndefined();
    expect(entry?.cliCompactionOverlays?.["claude-cli"]).toMatchObject({
      provider: "claude-cli",
      summary: "Condensed earlier context.",
      thresholdTokens: 290,
    });
    expect(entry?.cliCompactionOverlays?.["claude-cli"]?.tokensBefore).toBeGreaterThan(0);
    expect(entry?.cliCompactionOverlays?.["claude-cli"]).not.toHaveProperty("firstKeptEntryId");
    expect(entry?.cliCompactionOverlays?.["claude-cli"]?.compactedAtPromptTokens).toBeGreaterThan(
      0,
    );

    const persisted = JSON.parse(await fs.readFile(storePath, "utf8")) as {
      main: SessionEntry;
    };
    expect(persisted.main.cliSessionBindings).toBeUndefined();
    expect(persisted.main.cliSessionIds).toBeUndefined();
    expect(persisted.main.cliCompactionOverlays?.["claude-cli"]?.summary).toBe(
      "Condensed earlier context.",
    );
  });

  it("compacts bloated CLI resume sessions from Claude transcript usage even with small transcripts", async () => {
    const sessionDir = await fs.mkdtemp(path.join(rootDir, "openclaw-cli-usage-"));
    const sessionFile = path.join(sessionDir, "session.jsonl");
    await fs.writeFile(
      sessionFile,
      [
        JSON.stringify({
          id: "m1",
          message: {
            role: "user",
            content: [{ type: "text", text: "short context" }],
          },
        }),
      ].join("\n") + "\n",
      "utf8",
    );

    const storePath = path.join(rootDir, "sessions.json");
    const sessionKey = "main";
    await writeClaudeCliTranscript({
      homeDir,
      cliSessionId: "cli-session-1",
      usage: {
        input_tokens: 1_200,
        output_tokens: 500,
        cache_read_input_tokens: 170_000,
      },
    });
    const sessionEntry: SessionEntry = {
      sessionId: "session",
      updatedAt: Date.now(),
      sessionFile,
      cliSessionIds: { "claude-cli": "cli-session-1" },
      cliSessionBindings: {
        "claude-cli": {
          sessionId: "cli-session-1",
          lastUsage: {
            input: 10,
            output: 5,
            cacheRead: 20,
            updatedAt: 1_700_000_000_000,
          },
        },
      },
    };
    const sessionStore = { [sessionKey]: sessionEntry };
    await writeSessionStore(storePath, sessionKey, sessionEntry);
    runCliAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "Condensed hidden-usage context." }],
      meta: {},
    });

    const entry = await runPreflightCompactionIfNeeded({
      cfg: {
        agents: {
          defaults: {
            cliBackends: {
              "claude-cli": { command: "claude" },
            },
            compaction: {
              reserveTokensFloor: 20_000,
            },
          },
        },
      },
      followupRun: createFollowupRun({
        provider: "claude-cli",
        model: "sonnet",
        sessionFile,
      }),
      promptForEstimate: "hello",
      defaultModel: "claude-cli/sonnet",
      agentCfgContextTokens: 200_000,
      sessionEntry,
      sessionStore,
      sessionKey,
      storePath,
      isHeartbeat: false,
      replyOperation: createReplyOperation(),
    });

    expect(compactEmbeddedPiSessionMock).not.toHaveBeenCalled();
    expect(runCliAgentMock).toHaveBeenCalledTimes(1);
    const compactionCall = runCliAgentMock.mock.calls[0]?.[0] as {
      cliSessionId?: string;
      prompt?: string;
      sessionFile?: string;
    };
    expect(compactionCall.cliSessionId).toBeUndefined();
    expect(compactionCall.sessionFile).not.toBe(sessionFile);
    expect(compactionCall.prompt).toContain("ok");
    expect(compactionCall.prompt).not.toContain("short context");
    expect(entry?.cliSessionBindings).toBeUndefined();
    expect(entry?.cliSessionIds).toBeUndefined();
    expect(entry?.cliCompactionOverlays?.["claude-cli"]).toMatchObject({
      provider: "claude-cli",
      summary: "Condensed hidden-usage context.",
      tokensBefore: 171_200,
      thresholdTokens: 160_000,
    });
    expect(entry?.cliCompactionOverlays?.["claude-cli"]).not.toHaveProperty("firstKeptEntryId");

    const persisted = JSON.parse(await fs.readFile(storePath, "utf8")) as {
      main: SessionEntry;
    };
    expect(persisted.main.cliSessionBindings).toBeUndefined();
    expect(persisted.main.cliSessionIds).toBeUndefined();
    expect(persisted.main.cliCompactionOverlays?.["claude-cli"]?.summary).toBe(
      "Condensed hidden-usage context.",
    );
  });

  it("does not compact CLI sessions from OpenClaw-maintained usage when Claude transcript usage is unavailable", async () => {
    const sessionDir = await fs.mkdtemp(path.join(rootDir, "openclaw-cli-usage-missing-"));
    const sessionFile = path.join(sessionDir, "session.jsonl");
    await fs.writeFile(
      sessionFile,
      [
        JSON.stringify({
          id: "m1",
          message: {
            role: "user",
            content: [{ type: "text", text: "short context" }],
          },
        }),
      ].join("\n") + "\n",
      "utf8",
    );

    const storePath = path.join(rootDir, "sessions.json");
    const sessionKey = "main";
    const sessionEntry: SessionEntry = {
      sessionId: "session",
      updatedAt: Date.now(),
      sessionFile,
      cliSessionIds: { "claude-cli": "cli-session-missing-transcript" },
      cliSessionBindings: {
        "claude-cli": {
          sessionId: "cli-session-missing-transcript",
          lastUsage: {
            input: 1_200,
            output: 500,
            cacheRead: 170_000,
            updatedAt: 1_700_000_000_000,
          },
        },
      },
    };
    const sessionStore = { [sessionKey]: sessionEntry };
    await writeSessionStore(storePath, sessionKey, sessionEntry);

    const entry = await runPreflightCompactionIfNeeded({
      cfg: {
        agents: {
          defaults: {
            cliBackends: {
              "claude-cli": { command: "claude" },
            },
            compaction: {
              reserveTokensFloor: 20_000,
            },
          },
        },
      },
      followupRun: createFollowupRun({
        provider: "claude-cli",
        model: "sonnet",
        sessionFile,
      }),
      promptForEstimate: "hello",
      defaultModel: "claude-cli/sonnet",
      agentCfgContextTokens: 200_000,
      sessionEntry,
      sessionStore,
      sessionKey,
      storePath,
      isHeartbeat: false,
      replyOperation: createReplyOperation(),
    });

    expect(compactEmbeddedPiSessionMock).not.toHaveBeenCalled();
    expect(runCliAgentMock).not.toHaveBeenCalled();
    expect(entry?.cliSessionBindings?.["claude-cli"]?.lastUsage?.cacheRead).toBe(170_000);
    expect(entry?.cliCompactionOverlays).toBeUndefined();
  });

  it("uses configured prompts and stored bootstrap warning signatures", async () => {
    const sessionEntry: SessionEntry = {
      sessionId: "session",
      updatedAt: Date.now(),
      totalTokens: 80_000,
      compactionCount: 1,
      systemPromptReport: {
        source: "run",
        generatedAt: Date.now(),
        systemPrompt: { chars: 1, projectContextChars: 0, nonProjectContextChars: 1 },
        injectedWorkspaceFiles: [],
        skills: { promptChars: 0, entries: [] },
        tools: { listChars: 0, schemaChars: 0, entries: [] },
        bootstrapTruncation: {
          warningMode: "once",
          warningShown: true,
          promptWarningSignature: "sig-b",
          warningSignaturesSeen: ["sig-a", "sig-b"],
          truncatedFiles: 1,
          nearLimitFiles: 0,
          totalNearLimit: false,
        },
      },
    };
    registerMemoryFlushPlanResolver(() => ({
      softThresholdTokens: 4_000,
      forceFlushTranscriptBytes: 1_000_000_000,
      reserveTokensFloor: 20_000,
      prompt: "Write notes.\nNO_REPLY to memory/2023-11-14.md and MEMORY.md",
      systemPrompt: "Flush memory now. NO_REPLY memory/YYYY-MM-DD.md MEMORY.md",
      relativePath: "memory/2023-11-14.md",
    }));

    await runMemoryFlushIfNeeded({
      cfg: { agents: { defaults: { compaction: { memoryFlush: {} } } } },
      followupRun: createFollowupRun({ extraSystemPrompt: "extra system" }),
      sessionCtx: { Provider: "whatsapp" } as unknown as TemplateContext,
      defaultModel: "anthropic/claude-opus-4-6",
      agentCfgContextTokens: 100_000,
      resolvedVerboseLevel: "off",
      sessionEntry,
      sessionStore: { main: sessionEntry },
      sessionKey: "main",
      isHeartbeat: false,
      replyOperation: createReplyOperation(),
    });

    const flushCall = runEmbeddedPiAgentMock.mock.calls[0]?.[0] as {
      prompt?: string;
      extraSystemPrompt?: string;
      bootstrapPromptWarningSignaturesSeen?: string[];
      bootstrapPromptWarningSignature?: string;
      memoryFlushWritePath?: string;
      silentExpected?: boolean;
    };
    expect(flushCall.prompt).toContain("Write notes.");
    expect(flushCall.prompt).toContain("NO_REPLY");
    expect(flushCall.prompt).toContain("MEMORY.md");
    expect(flushCall.extraSystemPrompt).toContain("extra system");
    expect(flushCall.extraSystemPrompt).toContain("Flush memory now.");
    expect(flushCall.memoryFlushWritePath).toBe("memory/2023-11-14.md");
    expect(flushCall.silentExpected).toBe(true);
    expect(flushCall.bootstrapPromptWarningSignaturesSeen).toEqual(["sig-a", "sig-b"]);
    expect(flushCall.bootstrapPromptWarningSignature).toBe("sig-b");
  });
});
