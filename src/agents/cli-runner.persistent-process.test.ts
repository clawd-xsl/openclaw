import crypto from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReplyOperation } from "../auto-reply/reply/reply-run-registry.js";
import { onAgentEvent, resetAgentEventsForTest } from "../infra/agent-events.js";
import { restoreCliRunnerPrepareTestDeps, supervisorSpawnMock } from "./cli-runner.test-support.js";
import { executePreparedCliRun } from "./cli-runner/execute.js";
import {
  reapPersistentCliRuntimesForTest,
  resetPersistentCliRuntimesForTest,
} from "./cli-runner/persistent-process.js";
import type { PreparedCliRunContext } from "./cli-runner/types.js";

type SpawnInput = {
  argv?: string[];
  env?: Record<string, string>;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
};

type SpawnExit = {
  reason: "manual-cancel" | "overall-timeout" | "no-output-timeout" | "signal" | "exit";
  exitCode: number | null;
  exitSignal: NodeJS.Signals | number | null;
  durationMs: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  noOutputTimedOut: boolean;
};

type SpawnScenario = {
  onSpawn?: (params: {
    spawnInput: SpawnInput;
    claudeSessionId: string;
    spawnIndex: number;
    settleExit: (result: SpawnExit) => void;
  }) => void;
  onCancel?: (params: {
    spawnInput: SpawnInput;
    claudeSessionId: string;
    spawnIndex: number;
    reason: SpawnExit["reason"];
    settleExit: (result: SpawnExit) => void;
  }) => void;
  onWrite?: (params: {
    spawnInput: SpawnInput;
    claudeSessionId: string;
    spawnIndex: number;
    turnIndex: number;
    settleExit: (result: SpawnExit) => void;
    callback?: (err?: Error | null) => void;
  }) => void;
};

function buildPersistentContext(params?: {
  prompt?: string;
  systemPrompt?: string;
  mcpConfigHash?: string;
  abortSignal?: AbortSignal;
  replyOperation?: PreparedCliRunContext["params"]["replyOperation"];
  sessionId?: string;
  sessionKey?: string;
  backendEnv?: Record<string, string>;
  clearEnv?: string[];
  skillsSignature?: string;
  bundleMcpSerializedConfig?: string;
  bundleMcpEnv?: Record<string, string>;
  reusableCliSessionId?: string;
  thinkLevel?: PreparedCliRunContext["params"]["thinkLevel"];
  fastMode?: boolean;
  onAssistantDelta?: PreparedCliRunContext["params"]["onAssistantDelta"];
}): PreparedCliRunContext {
  const backend = {
    command: "claude",
    executionMode: "persistent-process" as const,
    args: [
      "--output-format",
      "stream-json",
      "--input-format",
      "stream-json",
      "--include-partial-messages",
      "--verbose",
      "--tools",
      "",
      "--setting-sources",
      "",
      "--settings",
      '{"disableAllHooks":true}',
      "--permission-mode",
      "bypassPermissions",
    ],
    resumeArgs: [
      "--output-format",
      "stream-json",
      "--input-format",
      "stream-json",
      "--include-partial-messages",
      "--verbose",
      "--tools",
      "",
      "--setting-sources",
      "",
      "--settings",
      '{"disableAllHooks":true}',
      "--permission-mode",
      "bypassPermissions",
      "--resume",
      "{sessionId}",
    ],
    output: "jsonl" as const,
    jsonlDialect: "claude-stream-json" as const,
    input: "stdin" as const,
    modelArg: "--model",
    sessionArg: "--session-id",
    sessionMode: "always" as const,
    systemPromptArg: "--system-prompt",
    systemPromptMode: "replace" as const,
    systemPromptWhen: "always" as const,
    serialize: true,
    env: params?.backendEnv,
    clearEnv: params?.clearEnv,
  };
  return {
    params: {
      sessionId: params?.sessionId ?? "session-main",
      sessionKey: params?.sessionKey ?? "agent:main:main",
      sessionFile: "/tmp/session.jsonl",
      workspaceDir: "/tmp",
      prompt: params?.prompt ?? "hello",
      provider: "claude-cli-streaming",
      model: "sonnet",
      thinkLevel: params?.thinkLevel,
      fastMode: params?.fastMode,
      timeoutMs: 5_000,
      runId: crypto.randomUUID(),
      abortSignal: params?.abortSignal,
      replyOperation: params?.replyOperation,
      onAssistantDelta: params?.onAssistantDelta,
    },
    started: Date.now(),
    workspaceDir: "/tmp",
    backendResolved: {
      id: "claude-cli-streaming",
      config: backend,
      bundleMcp: true,
      bundleMcpMode: "claude-config-file",
      pluginId: "anthropic",
    },
    preparedBackend: {
      backend,
      env: {},
      mcpConfigHash: params?.mcpConfigHash,
      claudeSkillsPluginSpec: { skills: [], signature: params?.skillsSignature },
      bundleMcpSpec: {
        mode: "claude-config-file",
        env: params?.bundleMcpEnv ?? {},
        serializedConfig: params?.bundleMcpSerializedConfig,
        mcpConfigHash: params?.mcpConfigHash,
      },
    },
    reusableCliSession: params?.reusableCliSessionId
      ? { sessionId: params.reusableCliSessionId }
      : {},
    modelId: "sonnet",
    normalizedModel: "sonnet",
    systemPrompt: params?.systemPrompt ?? "You are a persistent assistant.",
    systemPromptReport: {} as PreparedCliRunContext["systemPromptReport"],
    bootstrapPromptWarningLines: [],
  };
}

function buildReplyOperationMock(
  abortSignal = new AbortController().signal,
): PreparedCliRunContext["params"]["replyOperation"] & {
  attachBackend: ReturnType<typeof vi.fn>;
  detachBackend: ReturnType<typeof vi.fn>;
} {
  const attachBackend = vi.fn();
  const detachBackend = vi.fn();
  return {
    key: "reply-op",
    sessionId: "session-main",
    abortSignal,
    resetTriggered: false,
    phase: "running",
    result: null,
    setPhase: vi.fn(),
    updateSessionId: vi.fn(),
    attachBackend: attachBackend as unknown as ReplyOperation["attachBackend"] &
      ReturnType<typeof vi.fn>,
    detachBackend: detachBackend as unknown as ReplyOperation["detachBackend"] &
      ReturnType<typeof vi.fn>,
    complete: vi.fn(),
    fail: vi.fn(),
    abortByUser: vi.fn(),
    abortForRestart: vi.fn(),
  };
}

function readClaudeSettingsArg(argv: string[] | undefined): Record<string, unknown> {
  const index = argv?.indexOf("--settings") ?? -1;
  if (index < 0) {
    return {};
  }
  const raw = argv?.[index + 1];
  if (!raw) {
    return {};
  }
  return JSON.parse(raw) as Record<string, unknown>;
}

function installPersistentSpawnMock(params?: { scenarios?: SpawnScenario[] }) {
  const spawnInputs: SpawnInput[] = [];
  const settleExitBySpawnIndex = new Map<number, (result: SpawnExit) => void>();
  let spawnCount = 0;
  supervisorSpawnMock.mockImplementation(async (input) => {
    spawnCount += 1;
    const spawnIndex = spawnCount;
    const spawnInput = input as SpawnInput;
    spawnInputs.push(spawnInput);
    const claudeSessionId = `claude-session-${spawnIndex}`;
    let turnCount = 0;
    let settled = false;
    let resolveExit!: (value: SpawnExit) => void;
    const waitPromise = new Promise<SpawnExit>((resolve) => {
      resolveExit = resolve;
    });
    const settleExit = (result: SpawnExit) => {
      if (settled) {
        return;
      }
      settled = true;
      resolveExit(result);
    };
    settleExitBySpawnIndex.set(spawnIndex, settleExit);
    const scenario = params?.scenarios?.[spawnIndex - 1];
    scenario?.onSpawn?.({
      spawnInput,
      claudeSessionId,
      spawnIndex,
      settleExit,
    });
    return {
      runId: `persistent-${spawnIndex}`,
      pid: 2000 + spawnIndex,
      startedAtMs: Date.now(),
      stdin: {
        write: (_data: string, cb?: (err?: Error | null) => void) => {
          turnCount += 1;
          if (scenario?.onWrite) {
            scenario.onWrite({
              spawnInput,
              claudeSessionId,
              spawnIndex,
              turnIndex: turnCount,
              settleExit,
              callback: cb,
            });
            return;
          }
          spawnInput.onStdout?.(
            `${JSON.stringify({
              type: "system",
              subtype: "init",
              session_id: claudeSessionId,
            })}\n`,
          );
          spawnInput.onStdout?.(
            `${JSON.stringify({
              type: "stream_event",
              session_id: claudeSessionId,
              event: {
                type: "content_block_delta",
                delta: { type: "text_delta", text: `turn-${spawnIndex}-${turnCount}` },
              },
            })}\n`,
          );
          spawnInput.onStdout?.(
            `${JSON.stringify({
              type: "result",
              subtype: "success",
              session_id: claudeSessionId,
              result: `turn-${spawnIndex}-${turnCount}`,
              is_error: false,
            })}\n`,
          );
          cb?.(null);
        },
        end: () => {},
        destroy: () => {},
        destroyed: false,
      },
      wait: vi.fn(async () => await waitPromise),
      cancel: vi.fn((reason = "manual-cancel") => {
        if (scenario?.onCancel) {
          scenario.onCancel({
            spawnInput,
            claudeSessionId,
            spawnIndex,
            reason,
            settleExit,
          });
          return;
        }
        settleExit({
          reason,
          exitCode: null,
          exitSignal: "SIGKILL",
          durationMs: 1,
          stdout: "",
          stderr: "",
          timedOut: reason === "overall-timeout" || reason === "no-output-timeout",
          noOutputTimedOut: reason === "no-output-timeout",
        });
      }),
    };
  });
  return {
    spawnInputs,
    getSpawnCount: () => spawnCount,
    exitSpawn(spawnIndex: number, result: SpawnExit) {
      settleExitBySpawnIndex.get(spawnIndex)?.(result);
    },
  };
}

beforeEach(() => {
  resetAgentEventsForTest();
  restoreCliRunnerPrepareTestDeps();
  supervisorSpawnMock.mockReset();
});

afterEach(async () => {
  resetAgentEventsForTest();
  await resetPersistentCliRuntimesForTest();
});

describe("claude-cli-streaming persistent process runner", () => {
  it("reuses the same Claude process across turns when the launch context is stable and OpenClaw passes the reusable Claude session id", async () => {
    const controller = installPersistentSpawnMock();

    const first = await executePreparedCliRun(buildPersistentContext({ prompt: "first prompt" }));
    const second = await executePreparedCliRun(
      buildPersistentContext({
        prompt: "second prompt",
        reusableCliSessionId: "claude-session-1",
      }),
      "claude-session-1",
    );

    expect(first.text).toBe("turn-1-1");
    expect(first.sessionId).toBe("claude-session-1");
    expect(second.text).toBe("turn-1-2");
    expect(second.sessionId).toBe("claude-session-1");
    expect(controller.getSpawnCount()).toBe(1);
  });

  it("relaunches fresh on turn two when OpenClaw does not pass a reusable Claude session id", async () => {
    const controller = installPersistentSpawnMock();

    await executePreparedCliRun(buildPersistentContext({ prompt: "first prompt" }));
    const second = await executePreparedCliRun(buildPersistentContext({ prompt: "second prompt" }));

    expect(second.text).toBe("turn-2-1");
    expect(controller.getSpawnCount()).toBe(2);
    expect(controller.spawnInputs[1]?.argv).toContain("--session-id");
    expect(controller.spawnInputs[1]?.argv).not.toContain("--resume");
  });

  it("streams assistant snapshot growth after tool work on the persistent path", async () => {
    const agentEvents: Array<{ stream: string; text?: string; delta?: string }> = [];
    const stop = onAgentEvent((evt) => {
      agentEvents.push({
        stream: evt.stream,
        text: typeof evt.data.text === "string" ? evt.data.text : undefined,
        delta: typeof evt.data.delta === "string" ? evt.data.delta : undefined,
      });
    });
    const controller = installPersistentSpawnMock({
      scenarios: [
        {
          onWrite: ({ spawnInput, claudeSessionId, callback }) => {
            spawnInput.onStdout?.(
              `${JSON.stringify({
                type: "system",
                subtype: "init",
                session_id: claudeSessionId,
              })}\n`,
            );
            spawnInput.onStdout?.(
              `${JSON.stringify({
                type: "stream_event",
                session_id: claudeSessionId,
                event: {
                  type: "content_block_delta",
                  delta: { type: "text_delta", text: "Let me check." },
                },
              })}\n`,
            );
            spawnInput.onStdout?.(
              `${JSON.stringify({
                type: "assistant",
                session_id: claudeSessionId,
                message: {
                  role: "assistant",
                  content: [
                    { type: "text", text: "Let me check." },
                    { type: "tool_use", id: "toolu_1", name: "read", input: { path: "README.md" } },
                  ],
                },
              })}\n`,
            );
            spawnInput.onStdout?.(
              `${JSON.stringify({
                type: "assistant",
                session_id: claudeSessionId,
                message: {
                  role: "assistant",
                  content: [{ type: "text", text: "Let me check. It is 42." }],
                },
              })}\n`,
            );
            spawnInput.onStdout?.(
              `${JSON.stringify({
                type: "result",
                subtype: "success",
                session_id: claudeSessionId,
                result: "Let me check. It is 42.",
                is_error: false,
              })}\n`,
            );
            callback?.(null);
          },
        },
      ],
    });

    try {
      const liveDeltas: Array<{ text: string; delta: string }> = [];
      const result = await executePreparedCliRun(
        buildPersistentContext({
          prompt: "tool turn",
          onAssistantDelta: (delta) => {
            liveDeltas.push({ text: delta.text, delta: delta.delta });
          },
        }),
      );

      expect(result.text).toBe("Let me check. It is 42.");
      expect(result.streamedAssistantTexts).toEqual(["Let me check.", "Let me check. It is 42."]);
      expect(liveDeltas).toEqual([
        { text: "Let me check.", delta: "Let me check." },
        { text: "Let me check. It is 42.", delta: " It is 42." },
      ]);
      expect(agentEvents).toEqual([
        { stream: "assistant", text: "Let me check.", delta: "Let me check." },
        { stream: "assistant", text: "Let me check. It is 42.", delta: " It is 42." },
      ]);
      expect(controller.getSpawnCount()).toBe(1);
    } finally {
      stop();
    }
  });

  it("relaunches with --resume when the effective system prompt changes", async () => {
    const controller = installPersistentSpawnMock();

    await executePreparedCliRun(buildPersistentContext({ systemPrompt: "system prompt A" }));
    await executePreparedCliRun(
      buildPersistentContext({
        systemPrompt: "system prompt B",
        reusableCliSessionId: "claude-session-1",
      }),
      "claude-session-1",
    );

    expect(controller.getSpawnCount()).toBe(2);
    expect(controller.spawnInputs[0]?.argv).toContain("--session-id");
    expect(controller.spawnInputs[1]?.argv).toContain("--resume");
    expect(controller.spawnInputs[1]?.argv).toContain("claude-session-1");
  });

  it("passes native Claude thinking controls and relaunches when thinking level changes", async () => {
    const controller = installPersistentSpawnMock();

    await executePreparedCliRun(buildPersistentContext({ thinkLevel: "off" }));
    await executePreparedCliRun(
      buildPersistentContext({
        thinkLevel: "high",
        reusableCliSessionId: "claude-session-1",
      }),
      "claude-session-1",
    );

    expect(controller.getSpawnCount()).toBe(2);
    expect(controller.spawnInputs[0]?.argv).not.toContain("--effort");
    expect(controller.spawnInputs[0]?.env?.MAX_THINKING_TOKENS).toBe("0");
    expect(controller.spawnInputs[1]?.argv).toContain("--resume");
    expect(controller.spawnInputs[1]?.argv).toContain("--effort");
    expect(controller.spawnInputs[1]?.argv).toContain("high");
    expect(controller.spawnInputs[1]?.env).not.toHaveProperty("MAX_THINKING_TOKENS");
  });

  it("passes fast mode through Claude settings and relaunches when fast mode changes", async () => {
    const controller = installPersistentSpawnMock();

    await executePreparedCliRun(buildPersistentContext({ fastMode: true }));
    await executePreparedCliRun(
      buildPersistentContext({
        fastMode: false,
        reusableCliSessionId: "claude-session-1",
      }),
      "claude-session-1",
    );

    expect(controller.getSpawnCount()).toBe(2);
    expect(readClaudeSettingsArg(controller.spawnInputs[0]?.argv)).toMatchObject({
      disableAllHooks: true,
      fastMode: true,
    });
    expect(controller.spawnInputs[0]?.argv).not.toContain("--effort");
    expect(controller.spawnInputs[1]?.argv).toContain("--resume");
    expect(readClaudeSettingsArg(controller.spawnInputs[1]?.argv)).toMatchObject({
      disableAllHooks: true,
      fastMode: false,
    });
    expect(controller.spawnInputs[1]?.argv).not.toContain("--effort");
  });

  it("relaunches with --resume when the bundled MCP hash changes", async () => {
    const controller = installPersistentSpawnMock();

    await executePreparedCliRun(buildPersistentContext({ mcpConfigHash: "mcp-a" }));
    await executePreparedCliRun(
      buildPersistentContext({
        mcpConfigHash: "mcp-b",
        reusableCliSessionId: "claude-session-1",
      }),
      "claude-session-1",
    );

    expect(controller.getSpawnCount()).toBe(2);
    expect(controller.spawnInputs[1]?.argv).toContain("--resume");
    expect(controller.spawnInputs[1]?.argv).toContain("claude-session-1");
  });

  it("does not relaunch when only non-signature MCP materialization fields churn", async () => {
    const controller = installPersistentSpawnMock();

    await executePreparedCliRun(
      buildPersistentContext({
        mcpConfigHash: "mcp-stable",
        bundleMcpSerializedConfig: '{"mcpServers":{"openclaw":{"url":"http://127.0.0.1:1/mcp"}}}\n',
        bundleMcpEnv: { OPENCLAW_MCP_TEMP_FILE: "/tmp/mcp-a.json" },
      }),
    );
    await executePreparedCliRun(
      buildPersistentContext({
        mcpConfigHash: "mcp-stable",
        bundleMcpSerializedConfig: '{"mcpServers":{"openclaw":{"url":"http://127.0.0.1:2/mcp"}}}\n',
        bundleMcpEnv: { OPENCLAW_MCP_TEMP_FILE: "/tmp/mcp-b.json" },
        reusableCliSessionId: "claude-session-1",
      }),
      "claude-session-1",
    );

    expect(controller.getSpawnCount()).toBe(1);
  });

  it("relaunches with --resume when the Claude skills signature changes", async () => {
    const controller = installPersistentSpawnMock();

    await executePreparedCliRun(buildPersistentContext({ skillsSignature: "skills-a" }));
    await executePreparedCliRun(
      buildPersistentContext({
        skillsSignature: "skills-b",
        reusableCliSessionId: "claude-session-1",
      }),
      "claude-session-1",
    );

    expect(controller.getSpawnCount()).toBe(2);
    expect(controller.spawnInputs[1]?.argv).toContain("--resume");
    expect(controller.spawnInputs[1]?.argv).toContain("claude-session-1");
  });

  it("relaunches with --resume when backend env and clearEnv drift", async () => {
    const controller = installPersistentSpawnMock();

    await executePreparedCliRun(
      buildPersistentContext({
        backendEnv: { CLAUDE_FOO: "alpha" },
        clearEnv: ["CLAUDE_BAR"],
      }),
    );
    await executePreparedCliRun(
      buildPersistentContext({
        backendEnv: { CLAUDE_FOO: "beta" },
        clearEnv: ["CLAUDE_BAZ"],
        reusableCliSessionId: "claude-session-1",
      }),
      "claude-session-1",
    );

    expect(controller.getSpawnCount()).toBe(2);
    expect(controller.spawnInputs[1]?.argv).toContain("--resume");
    expect(controller.spawnInputs[1]?.argv).toContain("claude-session-1");
  });

  it("reaps idle runtimes and relaunches with the stored Claude session id", async () => {
    const controller = installPersistentSpawnMock();

    await executePreparedCliRun(buildPersistentContext({ prompt: "first prompt" }));
    await reapPersistentCliRuntimesForTest(Date.now() + 24 * 60 * 60 * 1000);
    await executePreparedCliRun(
      buildPersistentContext({ prompt: "second prompt" }),
      "claude-session-1",
    );

    expect(controller.getSpawnCount()).toBe(2);
    expect(controller.spawnInputs[1]?.argv).toContain("--resume");
    expect(controller.spawnInputs[1]?.argv).toContain("claude-session-1");
  });

  it("does not reap a runtime that became busy after the sweep snapshot", async () => {
    const controller = installPersistentSpawnMock({
      scenarios: [
        {
          onCancel: () => {
            // Hold the first stale runtime open so the sweep yields before checking the second.
          },
        },
      ],
    });

    await executePreparedCliRun(
      buildPersistentContext({ sessionId: "session-a", sessionKey: "agent:main:a" }),
    );
    await executePreparedCliRun(
      buildPersistentContext({ sessionId: "session-b", sessionKey: "agent:main:b" }),
    );

    const reapPromise = reapPersistentCliRuntimesForTest(Date.now() + 24 * 60 * 60 * 1000);
    const busyTurnPromise = executePreparedCliRun(
      buildPersistentContext({
        sessionId: "session-b",
        sessionKey: "agent:main:b",
        prompt: "busy turn",
      }),
      "claude-session-2",
    );

    controller.exitSpawn(1, {
      reason: "manual-cancel",
      exitCode: null,
      exitSignal: "SIGKILL",
      durationMs: 1,
      stdout: "",
      stderr: "",
      timedOut: false,
      noOutputTimedOut: false,
    });

    const busyTurn = await busyTurnPromise;
    await reapPromise;

    expect(busyTurn.text).toBe("turn-2-2");
    expect(controller.getSpawnCount()).toBe(2);
  });

  it("evicts the runtime and relaunches fresh after a session_expired result", async () => {
    const controller = installPersistentSpawnMock({
      scenarios: [
        {
          onWrite: ({ spawnInput, claudeSessionId, callback }) => {
            spawnInput.onStdout?.(
              `${JSON.stringify({
                type: "result",
                subtype: "error",
                session_id: claudeSessionId,
                result: "HTTP 410: session not found",
                is_error: true,
              })}\n`,
            );
            callback?.(null);
          },
        },
      ],
    });

    await expect(executePreparedCliRun(buildPersistentContext())).rejects.toMatchObject({
      name: "FailoverError",
      reason: "session_expired",
    });

    const second = await executePreparedCliRun(buildPersistentContext({ prompt: "fresh retry" }));

    expect(second.text).toBe("turn-2-1");
    expect(controller.getSpawnCount()).toBe(2);
    expect(controller.spawnInputs[1]?.argv).toContain("--session-id");
    expect(controller.spawnInputs[1]?.argv).not.toContain("--resume");
  });

  it("rejects immediately when the turn is already aborted before write begins", async () => {
    const controller = installPersistentSpawnMock();
    const abortController = new AbortController();
    abortController.abort();

    await expect(
      executePreparedCliRun(
        buildPersistentContext({
          abortSignal: abortController.signal,
        }),
      ),
    ).rejects.toMatchObject({
      name: "AbortError",
      message: "CLI run aborted",
    });

    expect(controller.getSpawnCount()).toBe(0);
  });

  it("does not leak reply backends when the turn aborts before attachable work begins", async () => {
    const abortController = new AbortController();
    const replyOperation = buildReplyOperationMock(abortController.signal);
    const controller = installPersistentSpawnMock({
      scenarios: [
        {
          onSpawn: () => {
            abortController.abort();
          },
        },
      ],
    });

    await expect(
      executePreparedCliRun(
        buildPersistentContext({
          abortSignal: abortController.signal,
          replyOperation,
        }),
      ),
    ).rejects.toMatchObject({
      name: "AbortError",
      message: "CLI run aborted",
    });

    expect(controller.getSpawnCount()).toBe(1);
    expect(replyOperation.attachBackend).not.toHaveBeenCalled();
    expect(replyOperation.detachBackend).not.toHaveBeenCalled();
  });

  it("does not implicitly resume a cached Claude session id after an aborted first turn when OpenClaw does not provide a reusable session id", async () => {
    const abortController = new AbortController();
    const controller = installPersistentSpawnMock({
      scenarios: [
        {
          onSpawn: ({ spawnInput, claudeSessionId }) => {
            spawnInput.onStdout?.(
              `${JSON.stringify({
                type: "system",
                subtype: "init",
                session_id: claudeSessionId,
              })}\n`,
            );
          },
          onWrite: ({ callback }) => {
            callback?.(null);
            queueMicrotask(() => {
              abortController.abort();
            });
          },
        },
      ],
    });

    await expect(
      executePreparedCliRun(
        buildPersistentContext({
          prompt: "first prompt",
          abortSignal: abortController.signal,
        }),
      ),
    ).rejects.toMatchObject({
      name: "AbortError",
    });

    const second = await executePreparedCliRun(
      buildPersistentContext({
        prompt: "second prompt",
      }),
    );

    expect(second.text).toBe("turn-2-1");
    expect(controller.getSpawnCount()).toBe(2);
    expect(controller.spawnInputs[1]?.argv).toContain("--session-id");
    expect(controller.spawnInputs[1]?.argv).not.toContain("--resume");
  });

  it("surfaces a mid-turn process exit through the same failover path as one-shot runs", async () => {
    installPersistentSpawnMock({
      scenarios: [
        {
          onWrite: ({ callback, settleExit }) => {
            callback?.(null);
            queueMicrotask(() => {
              settleExit({
                reason: "exit",
                exitCode: 1,
                exitSignal: null,
                durationMs: 1,
                stdout: "",
                stderr: "rate limit exceeded",
                timedOut: false,
                noOutputTimedOut: false,
              });
            });
          },
        },
      ],
    });

    const runPromise = executePreparedCliRun(
      buildPersistentContext({ prompt: "mid-turn failure" }),
    );

    await expect(runPromise).rejects.toMatchObject({
      name: "FailoverError",
      reason: "rate_limit",
    });
  });
});
