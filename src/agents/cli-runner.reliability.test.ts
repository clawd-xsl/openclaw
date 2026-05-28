import { describe, expect, it } from "vitest";
import { runPreparedCliAgent } from "./cli-runner.js";
import {
  createManagedRun,
  enqueueSystemEventMock,
  requestHeartbeatNowMock,
  supervisorSpawnMock,
} from "./cli-runner.test-support.js";
import { executePreparedCliRun } from "./cli-runner/execute.js";
import { resolveCliNoOutputTimeoutMs } from "./cli-runner/helpers.js";
import type { PreparedCliRunContext } from "./cli-runner/types.js";
import { CliSessionContinuityError } from "./cli-session.js";

function buildPreparedContext(params?: {
  sessionKey?: string;
  cliSessionId?: string;
  runId?: string;
  invalidatedReason?: "auth-profile" | "auth-epoch" | "system-prompt" | "mcp";
  continuityBreakMode?: "internal-retry" | "throw";
}): PreparedCliRunContext {
  const backend = {
    command: "codex",
    args: ["exec", "--json"],
    output: "text" as const,
    input: "arg" as const,
    modelArg: "--model",
    sessionMode: "existing" as const,
    serialize: true,
  };
  return {
    params: {
      sessionId: "s1",
      sessionKey: params?.sessionKey,
      sessionFile: "/tmp/session.jsonl",
      workspaceDir: "/tmp",
      prompt: "hi",
      provider: "codex-cli",
      model: "gpt-5.4",
      thinkLevel: "low",
      timeoutMs: 1_000,
      runId: params?.runId ?? "run-2",
      continuityBreakMode: params?.continuityBreakMode,
      cliSessionBinding: params?.cliSessionId
        ? {
            sessionId: params.cliSessionId,
          }
        : undefined,
    },
    started: Date.now(),
    workspaceDir: "/tmp",
    backendResolved: {
      id: "codex-cli",
      config: backend,
      bundleMcp: false,
      pluginId: "openai",
    },
    preparedBackend: {
      backend,
      env: {},
    },
    reusableCliSession: params?.cliSessionId
      ? {
          sessionId: params.cliSessionId,
          invalidatedReason: params.invalidatedReason,
        }
      : {},
    modelId: "gpt-5.4",
    normalizedModel: "gpt-5.4",
    systemPrompt: "You are a helpful assistant.",
    systemPromptReport: {} as PreparedCliRunContext["systemPromptReport"],
    bootstrapPromptWarningLines: [],
  };
}

describe("runCliAgent reliability", () => {
  it("fails with timeout when no-output watchdog trips", async () => {
    supervisorSpawnMock.mockResolvedValueOnce(
      createManagedRun({
        reason: "no-output-timeout",
        exitCode: null,
        exitSignal: "SIGKILL",
        durationMs: 200,
        stdout: "",
        stderr: "",
        timedOut: true,
        noOutputTimedOut: true,
      }),
    );

    await expect(
      executePreparedCliRun(
        buildPreparedContext({ cliSessionId: "thread-123", runId: "run-2" }),
        "thread-123",
      ),
    ).rejects.toThrow("produced no output");
  });

  it("enqueues a system event and heartbeat wake on no-output watchdog timeout for session runs", async () => {
    supervisorSpawnMock.mockResolvedValueOnce(
      createManagedRun({
        reason: "no-output-timeout",
        exitCode: null,
        exitSignal: "SIGKILL",
        durationMs: 200,
        stdout: "",
        stderr: "",
        timedOut: true,
        noOutputTimedOut: true,
      }),
    );

    await expect(
      executePreparedCliRun(
        buildPreparedContext({
          sessionKey: "agent:main:main",
          cliSessionId: "thread-123",
          runId: "run-2b",
        }),
        "thread-123",
      ),
    ).rejects.toThrow("produced no output");

    expect(enqueueSystemEventMock).toHaveBeenCalledTimes(1);
    const [notice, opts] = enqueueSystemEventMock.mock.calls[0] ?? [];
    expect(String(notice)).toContain("produced no output");
    expect(String(notice)).toContain("interactive input or an approval prompt");
    expect(opts).toMatchObject({ sessionKey: "agent:main:main" });
    expect(requestHeartbeatNowMock).toHaveBeenCalledWith({
      reason: "cli:watchdog:stall",
      sessionKey: "agent:main:main",
    });
  });

  it("fails with timeout when overall timeout trips", async () => {
    supervisorSpawnMock.mockResolvedValueOnce(
      createManagedRun({
        reason: "overall-timeout",
        exitCode: null,
        exitSignal: "SIGKILL",
        durationMs: 200,
        stdout: "",
        stderr: "",
        timedOut: true,
        noOutputTimedOut: false,
      }),
    );

    await expect(
      executePreparedCliRun(
        buildPreparedContext({ cliSessionId: "thread-123", runId: "run-3" }),
        "thread-123",
      ),
    ).rejects.toThrow("exceeded timeout");
  });

  it("throws a continuity error instead of silently minting a new CLI thread when reuse is invalidated", async () => {
    await expect(
      runPreparedCliAgent(
        buildPreparedContext({
          sessionKey: "agent:main:main",
          cliSessionId: "thread-123",
          invalidatedReason: "mcp",
          continuityBreakMode: "throw",
        }),
      ),
    ).rejects.toMatchObject<CliSessionContinuityError>({
      name: "CliSessionContinuityError",
      reason: "mcp",
      previousCliSessionId: "thread-123",
      provider: "codex-cli",
    });
  });

  it("throws a continuity error for session-expired when auto-reply requests rollover", async () => {
    supervisorSpawnMock.mockClear();
    supervisorSpawnMock.mockResolvedValueOnce(
      createManagedRun({
        reason: "exit",
        exitCode: 1,
        exitSignal: null,
        durationMs: 150,
        stdout: "",
        stderr: "session expired",
        timedOut: false,
        noOutputTimedOut: false,
      }),
    );

    await expect(
      runPreparedCliAgent(
        buildPreparedContext({
          sessionKey: "agent:main:subagent:retry",
          runId: "run-session-expired",
          cliSessionId: "thread-123",
          continuityBreakMode: "throw",
        }),
      ),
    ).rejects.toMatchObject<CliSessionContinuityError>({
      name: "CliSessionContinuityError",
      reason: "session_expired",
      previousCliSessionId: "thread-123",
      provider: "codex-cli",
    });

    expect(supervisorSpawnMock).toHaveBeenCalledTimes(1);
  });

  it("rethrows the retry failure when session-expired recovery retry also fails", async () => {
    supervisorSpawnMock.mockClear();
    supervisorSpawnMock.mockResolvedValueOnce(
      createManagedRun({
        reason: "exit",
        exitCode: 1,
        exitSignal: null,
        durationMs: 150,
        stdout: "",
        stderr: "session expired",
        timedOut: false,
        noOutputTimedOut: false,
      }),
    );
    supervisorSpawnMock.mockResolvedValueOnce(
      createManagedRun({
        reason: "exit",
        exitCode: 1,
        exitSignal: null,
        durationMs: 150,
        stdout: "",
        stderr: "rate limit exceeded",
        timedOut: false,
        noOutputTimedOut: false,
      }),
    );

    await expect(
      runPreparedCliAgent(
        buildPreparedContext({
          sessionKey: "agent:main:subagent:retry",
          runId: "run-retry-failure",
          cliSessionId: "thread-123",
        }),
      ),
    ).rejects.toThrow("rate limit exceeded");

    expect(supervisorSpawnMock).toHaveBeenCalledTimes(2);
  });

  it("returns the assembled CLI prompt in meta for raw trace consumers", async () => {
    supervisorSpawnMock.mockResolvedValueOnce(
      createManagedRun({
        reason: "exit",
        exitCode: 0,
        exitSignal: null,
        durationMs: 50,
        stdout: "hello from cli",
        stderr: "",
        timedOut: false,
        noOutputTimedOut: false,
      }),
    );

    const result = await runPreparedCliAgent({
      ...buildPreparedContext(),
      bootstrapPromptWarningLines: ["Warning: prompt budget low."],
    });

    expect(result.meta.finalPromptText).toContain("Warning: prompt budget low.");
    expect(result.meta.finalPromptText).toContain("hi");
    expect(result.meta.finalAssistantRawText).toBe("hello from cli");
    expect(result.meta.executionTrace).toMatchObject({
      winnerProvider: "codex-cli",
      winnerModel: "gpt-5.4",
      fallbackUsed: false,
      runner: "cli",
      attempts: [{ provider: "codex-cli", model: "gpt-5.4", result: "success" }],
    });
    expect(result.meta.requestShaping).toMatchObject({
      thinking: "low",
    });
    expect(result.meta.completion).toMatchObject({
      finishReason: "stop",
      stopReason: "completed",
      refusal: false,
    });
  });

  it("keeps raw assistant output separate from transformed visible CLI output", async () => {
    supervisorSpawnMock.mockResolvedValueOnce(
      createManagedRun({
        reason: "exit",
        exitCode: 0,
        exitSignal: null,
        durationMs: 50,
        stdout: "hello from cli",
        stderr: "",
        timedOut: false,
        noOutputTimedOut: false,
      }),
    );

    const result = await runPreparedCliAgent({
      ...buildPreparedContext(),
      backendResolved: {
        ...buildPreparedContext().backendResolved,
        textTransforms: {
          output: [{ from: "hello", to: "goodbye" }],
        },
      },
    });

    expect(result.payloads).toEqual([{ text: "goodbye from cli" }]);
    expect(result.meta.finalAssistantVisibleText).toBe("goodbye from cli");
    expect(result.meta.finalAssistantRawText).toBe("hello from cli");
  });

  it("preserves multiple finalized Claude payloads instead of collapsing to the last one", async () => {
    supervisorSpawnMock.mockResolvedValueOnce(
      createManagedRun({
        reason: "exit",
        exitCode: 0,
        exitSignal: null,
        durationMs: 50,
        stdout: [
          JSON.stringify({ type: "init", session_id: "session-multi" }),
          JSON.stringify({
            type: "assistant",
            session_id: "session-multi",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "First reply" }],
            },
          }),
          JSON.stringify({
            type: "assistant",
            session_id: "session-multi",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "Second reply" }],
            },
          }),
          JSON.stringify({
            type: "result",
            session_id: "session-multi",
            result: "Second reply",
          }),
        ].join("\n"),
        stderr: "",
        timedOut: false,
        noOutputTimedOut: false,
      }),
    );

    const base = buildPreparedContext();
    const result = await runPreparedCliAgent({
      ...base,
      backendResolved: {
        ...base.backendResolved,
        id: "claude-cli",
      },
      preparedBackend: {
        ...base.preparedBackend,
        backend: {
          command: "claude",
          args: ["-p", "--output-format", "stream-json"],
          output: "jsonl",
          input: "stdin",
          sessionMode: "always",
          serialize: true,
        },
      },
      params: {
        ...base.params,
        provider: "claude-cli",
      },
    });

    expect(result.payloads).toEqual([{ text: "First reply" }, { text: "Second reply" }]);
    expect(result.meta.finalAssistantVisibleText).toBe("Second reply");
  });

  it("marks empty structured Claude CLI sessions for clearing", async () => {
    supervisorSpawnMock.mockResolvedValueOnce(
      createManagedRun({
        reason: "exit",
        exitCode: 0,
        exitSignal: null,
        durationMs: 50,
        stdout: [
          JSON.stringify({ type: "init", session_id: "empty-session" }),
          JSON.stringify({
            type: "assistant",
            session_id: "empty-session",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "" }],
            },
          }),
          JSON.stringify({
            type: "result",
            session_id: "empty-session",
            result: "",
          }),
        ].join("\n"),
        stderr: "",
        timedOut: false,
        noOutputTimedOut: false,
      }),
    );

    const base = buildPreparedContext({ cliSessionId: "previous-session" });
    const result = await runPreparedCliAgent({
      ...base,
      backendResolved: {
        ...base.backendResolved,
        id: "claude-cli-streaming",
      },
      preparedBackend: {
        ...base.preparedBackend,
        backend: {
          command: "claude",
          args: ["-p", "--output-format", "stream-json"],
          output: "jsonl",
          input: "stdin",
          sessionMode: "always",
          serialize: true,
          jsonlDialect: "claude-stream-json",
        },
      },
      params: {
        ...base.params,
        provider: "claude-cli-streaming",
      },
    });

    expect(result.payloads).toBeUndefined();
    expect(result.meta.agentMeta).toMatchObject({
      sessionId: "empty-session",
      provider: "claude-cli-streaming",
      clearCliSession: true,
    });
    expect(result.meta.agentMeta?.cliSessionBinding).toBeUndefined();
  });
});

describe("resolveCliNoOutputTimeoutMs", () => {
  it("uses backend-configured resume watchdog override", () => {
    const timeoutMs = resolveCliNoOutputTimeoutMs({
      backend: {
        command: "codex",
        reliability: {
          watchdog: {
            resume: {
              noOutputTimeoutMs: 42_000,
            },
          },
        },
      },
      timeoutMs: 120_000,
      useResume: true,
    });
    expect(timeoutMs).toBe(42_000);
  });
});
