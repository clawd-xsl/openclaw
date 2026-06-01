import fs from "node:fs/promises";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/memory-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { __testing, registerSessionRolloverMemoryFlush } from "./rollover-memory-flush.js";
import { createMemoryCoreTestHarness } from "./test-helpers.js";

const { createTempWorkspace } = createMemoryCoreTestHarness();

type RolloverPluginApi = Parameters<typeof registerSessionRolloverMemoryFlush>[0];
type SessionEndHook = (
  event: {
    sessionId: string;
    sessionKey?: string;
    sessionFile?: string;
    nextSessionId?: string;
  },
  ctx: {
    agentId?: string;
    sessionId: string;
    sessionKey?: string;
  },
) => Promise<void>;
type RolloverRunCall = {
  agentId?: string;
  trigger?: string;
  provider?: string;
  model?: string;
  disableMessageTool?: boolean;
  silentExpected?: boolean;
  timeoutMs?: number;
  memoryFlushWritePath?: string;
  prompt?: string;
  extraSystemPrompt?: string;
  sessionFile?: string;
};

afterEach(() => {
  __testing.resetHandledSessionIds();
});

function getSessionEndHandler(onMock: ReturnType<typeof vi.fn>): SessionEndHook {
  const call = onMock.mock.calls.find(([hookName]) => hookName === "session_end");
  if (!call) {
    throw new Error("session_end hook was not registered");
  }
  return call[1] as SessionEndHook;
}

function createApi(params: {
  cfg: OpenClawConfig;
  workspaceDir: string;
  runEmbeddedPiAgent: ReturnType<typeof vi.fn>;
}) {
  const on = vi.fn();
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  const api = {
    config: params.cfg,
    pluginConfig: {},
    logger,
    runtime: {
      config: {
        loadConfig: () => params.cfg,
      },
      agent: {
        defaults: {
          provider: "openai",
          model: "gpt-5.4",
        },
        resolveAgentWorkspaceDir: () => params.workspaceDir,
        resolveAgentDir: () => path.join(params.workspaceDir, ".openclaw", "agents", "main"),
        resolveAgentTimeoutMs: () => 12_345,
        runEmbeddedPiAgent: params.runEmbeddedPiAgent,
      },
    },
    on,
  };
  return { api: api as unknown as RolloverPluginApi, on, logger };
}

describe("registerSessionRolloverMemoryFlush", () => {
  it("runs a one-shot memory flush when the main session rolls over", async () => {
    const workspaceDir = await createTempWorkspace("memory-rollover-flush-");
    const transcriptPath = path.join(workspaceDir, "ended-session.jsonl");
    await fs.writeFile(
      transcriptPath,
      [
        JSON.stringify({ type: "session", id: "ended-session", version: 2 }),
        JSON.stringify({
          id: "u1",
          message: {
            role: "user",
            content: [{ type: "text", text: "I signed up for a new gym." }],
          },
        }),
        JSON.stringify({
          id: "a1",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "You said you want to lift on Tuesdays and Fridays." }],
          },
        }),
      ].join("\n"),
      "utf8",
    );

    const runEmbeddedPiAgent = vi.fn(async () => ({ payloads: [], meta: {} }));
    const cfg = {
      agents: {
        defaults: {
          model: { primary: "claude-cli-streaming/claude-opus-4-7" },
          compaction: {
            memoryFlush: {
              prompt: "Store durable notes in memory/YYYY-MM-DD.md.",
            },
          },
        },
      },
    } as OpenClawConfig;
    const { api, on, logger } = createApi({ cfg, workspaceDir, runEmbeddedPiAgent });

    registerSessionRolloverMemoryFlush(api);
    await getSessionEndHandler(on)(
      {
        sessionId: "ended-session",
        sessionKey: "agent:main:main",
        sessionFile: transcriptPath,
        nextSessionId: "next-session",
      },
      {
        agentId: "main",
        sessionId: "ended-session",
        sessionKey: "agent:main:main",
      },
    );

    expect(runEmbeddedPiAgent).toHaveBeenCalledTimes(1);
    const call = (runEmbeddedPiAgent.mock.calls as unknown as Array<[RolloverRunCall]>)[0]?.[0];
    if (!call) {
      throw new Error("expected rollover flush run");
    }
    expect(call).toMatchObject({
      agentId: "main",
      trigger: "memory",
      provider: "claude-cli-streaming",
      model: "claude-opus-4-7",
      disableMessageTool: true,
      silentExpected: true,
      timeoutMs: 12_345,
    });
    expect(call?.memoryFlushWritePath).toMatch(/^memory\/\d{4}-\d{2}-\d{2}\.md$/);
    expect(call?.prompt).toContain("[Ended session transcript]");
    expect(call?.prompt).toContain("User: I signed up for a new gym.");
    expect(call?.prompt).toContain("Assistant: You said you want to lift on Tuesdays and Fridays.");
    expect(call?.prompt).toContain("[Memory flush task]");
    expect(call?.extraSystemPrompt).toContain("Session rollover memory flush.");
    if (!call.sessionFile) {
      throw new Error("expected temporary memory flush session file");
    }
    await expect(fs.access(call.sessionFile)).rejects.toThrow();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("resolves rollover model refs from configured aliases", () => {
    const resolved = __testing.resolveRolloverModelRef({
      cfg: {
        agents: {
          defaults: {
            model: { primary: "opus" },
            models: {
              "claude-cli-streaming/claude-opus-4-7": { alias: "opus" },
            },
          },
        },
      } as OpenClawConfig,
      agentId: "main",
      fallbackProvider: "openai",
      fallbackModel: "gpt-5.4",
    });

    expect(resolved).toEqual({
      provider: "claude-cli-streaming",
      model: "claude-opus-4-7",
    });
  });

  it("skips when there is no replacement session", async () => {
    const workspaceDir = await createTempWorkspace("memory-rollover-flush-");
    const runEmbeddedPiAgent = vi.fn(async () => ({ payloads: [], meta: {} }));
    const { api, on } = createApi({
      cfg: {} as OpenClawConfig,
      workspaceDir,
      runEmbeddedPiAgent,
    });

    registerSessionRolloverMemoryFlush(api);
    await getSessionEndHandler(on)(
      {
        sessionId: "ended-session",
        sessionKey: "agent:main:main",
        sessionFile: path.join(workspaceDir, "ended-session.jsonl"),
      },
      {
        agentId: "main",
        sessionId: "ended-session",
        sessionKey: "agent:main:main",
      },
    );

    expect(runEmbeddedPiAgent).not.toHaveBeenCalled();
  });
});
