// Tests CLI dispatch arguments and runtime selection for agent runner turns.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EmbeddedAgentRunResult } from "../../agents/embedded-agent-runner/types.js";
import { createAgentRunRestartAbortError } from "../../agents/run-termination.js";
import {
  emitAgentEvent,
  getAgentEventLifecycleGeneration,
  onAgentEvent,
  resetAgentEventsForTest,
} from "../../infra/agent-events.js";
import {
  createCliAssistantBlockStreamer,
  createCliToolSummaryTracker,
  keepCliSessionBindingOnlyWhenReused,
  runCliAgentWithLifecycle,
} from "./agent-runner-cli-dispatch.js";
import { createBlockReplyPipeline } from "./block-reply-pipeline.js";

const cliDispatchState = vi.hoisted(() => ({
  runCliAgentMock: vi.fn(),
}));

vi.mock("../../agents/cli-runner.js", () => ({
  runCliAgent: (...args: unknown[]) => cliDispatchState.runCliAgentMock(...args),
}));

afterEach(() => {
  vi.useRealTimers();
  resetAgentEventsForTest();
  cliDispatchState.runCliAgentMock.mockReset();
});

describe("runCliAgentWithLifecycle", () => {
  it("keeps the captured lifecycle generation on start and terminal events", async () => {
    const events: Array<{
      stream?: string;
      lifecycleGeneration?: string;
      data?: Record<string, unknown>;
    }> = [];
    const lifecycleGeneration = getAgentEventLifecycleGeneration();
    const stop = onAgentEvent((event) => {
      if (event.runId === "run-before-restart") {
        events.push(event);
      }
    });
    cliDispatchState.runCliAgentMock.mockResolvedValueOnce({
      payloads: [],
      meta: { durationMs: 1 },
    } satisfies EmbeddedAgentRunResult);

    try {
      await runCliAgentWithLifecycle({
        runId: "run-before-restart",
        lifecycleGeneration,
        provider: "claude-cli",
        runParams: {
          sessionId: "session-1",
          sessionFile: "/tmp/session.jsonl",
          workspaceDir: "/tmp/workspace",
          prompt: "hello",
          provider: "claude-cli",
          model: "claude",
          thinkLevel: "off",
          timeoutMs: 1_000,
          runId: "run-before-restart",
        },
      });
    } finally {
      stop();
    }

    const lifecycleEvents = events.filter((event) => event.stream === "lifecycle");
    expect(lifecycleEvents).toHaveLength(2);
    expect(
      lifecycleEvents.every((event) => event.lifecycleGeneration === lifecycleGeneration),
    ).toBe(true);
  });

  it("preserves restart ownership when the CLI resolves after cancellation", async () => {
    const events: Array<{ stream?: string; data?: Record<string, unknown> }> = [];
    const stop = onAgentEvent((event) => {
      if (event.runId === "run-restart") {
        events.push(event);
      }
    });
    const controller = new AbortController();
    cliDispatchState.runCliAgentMock.mockImplementationOnce(async () => {
      controller.abort(createAgentRunRestartAbortError());
      return {
        payloads: [{ text: "stale result" }],
        meta: { durationMs: 1 },
      } satisfies EmbeddedAgentRunResult;
    });

    await expect(
      runCliAgentWithLifecycle({
        runId: "run-restart",
        provider: "claude-cli",
        runParams: {
          sessionId: "session-1",
          sessionFile: "/tmp/session.jsonl",
          workspaceDir: "/tmp/workspace",
          prompt: "hello",
          provider: "claude-cli",
          model: "claude",
          thinkLevel: "off",
          timeoutMs: 1_000,
          runId: "run-restart",
          abortSignal: controller.signal,
        },
      }),
    ).rejects.toThrow("agent run aborted for restart");
    stop();

    const terminal = events.find(
      (event) => event.stream === "lifecycle" && event.data?.phase === "error",
    );
    expect(terminal?.data).toMatchObject({
      aborted: true,
      stopReason: "restart",
    });
    expect(events.some((event) => event.stream === "assistant")).toBe(false);
  });

  it("propagates yielded result metadata on lifecycle end", async () => {
    const events: Array<{ stream?: string; data?: Record<string, unknown> }> = [];
    const stop = onAgentEvent((event) => {
      if (event.runId === "run-yielded") {
        events.push(event);
      }
    });
    cliDispatchState.runCliAgentMock.mockResolvedValueOnce({
      payloads: [],
      meta: {
        durationMs: 1,
        yielded: true,
        livenessState: "paused",
        stopReason: "end_turn",
      },
    } satisfies EmbeddedAgentRunResult);

    try {
      await runCliAgentWithLifecycle({
        runId: "run-yielded",
        provider: "claude-cli",
        runParams: {
          sessionId: "session-1",
          sessionFile: "/tmp/session.jsonl",
          workspaceDir: "/tmp/workspace",
          prompt: "hello",
          provider: "claude-cli",
          model: "claude",
          thinkLevel: "off",
          timeoutMs: 1_000,
          runId: "run-yielded",
        },
      });
    } finally {
      stop();
    }

    const terminal = events.find(
      (event) => event.stream === "lifecycle" && event.data?.phase === "end",
    );
    expect(terminal?.data).toMatchObject({
      yielded: true,
      livenessState: "paused",
      stopReason: "end_turn",
    });
  });

  it("keeps assistant deltas ordered across tool and commentary boundaries", async () => {
    const delivered: string[] = [];
    cliDispatchState.runCliAgentMock.mockImplementationOnce(async () => {
      emitAgentEvent({
        runId: "run-blocks",
        stream: "assistant",
        data: { text: "First", delta: "First" },
      });
      emitAgentEvent({
        runId: "run-blocks",
        stream: "tool",
        data: { phase: "start", name: "Read", toolCallId: "tool-1" },
      });
      emitAgentEvent({
        runId: "run-blocks",
        stream: "assistant",
        data: { text: "First second", delta: " second" },
      });
      emitAgentEvent({
        runId: "run-blocks",
        stream: "item",
        data: { kind: "preamble", progressText: "Checking one more thing." },
      });
      emitAgentEvent({
        runId: "run-blocks",
        stream: "assistant",
        data: { text: "First second third", delta: " third" },
      });
      return {
        payloads: [{ text: "First second third" }],
        meta: { durationMs: 1 },
      } satisfies EmbeddedAgentRunResult;
    });

    await runCliAgentWithLifecycle({
      runId: "run-blocks",
      provider: "claude-cli",
      onAssistantDelta: async (delta) => {
        delivered.push(`delta:${delta}`);
      },
      onAssistantBoundary: async () => {
        delivered.push("boundary");
      },
      runParams: {
        sessionId: "session-1",
        sessionFile: "/tmp/session.jsonl",
        workspaceDir: "/tmp/workspace",
        prompt: "hello",
        provider: "claude-cli",
        model: "claude",
        thinkLevel: "off",
        timeoutMs: 1_000,
        runId: "run-blocks",
      },
    });

    expect(delivered).toEqual([
      "delta:First",
      "boundary",
      "delta: second",
      "boundary",
      "delta: third",
      "boundary",
    ]);
  });
});

describe("createCliAssistantBlockStreamer", () => {
  it("concatenates literal deltas and drops buffered text after abort", async () => {
    const delivered: string[] = [];
    let aborted = false;
    const pipeline = createBlockReplyPipeline({
      onBlockReply: async (payload) => {
        if (payload.text) {
          delivered.push(payload.text);
        }
      },
      timeoutMs: 5_000,
    });
    const streamer = createCliAssistantBlockStreamer({
      coalescing: {
        minChars: 100,
        maxChars: 1_000,
        idleMs: 0,
        joiner: "\n\n",
      },
      shouldAbort: () => aborted,
      deliver: async (text) => {
        pipeline.enqueue({ text });
        await pipeline.flush({ force: true });
      },
    });

    streamer.enqueue("Hello");
    streamer.enqueue(" world");
    await streamer.flush({ force: true });

    streamer.enqueue(" stale");
    aborted = true;
    await streamer.flush({ force: true });
    streamer.stop();

    expect(delivered).toEqual(["Hello world"]);
    expect(pipeline.didStream()).toBe(true);
    expect(pipeline.hasSentPayload({ text: "Hello world" })).toBe(true);
  });
});

describe("keepCliSessionBindingOnlyWhenReused", () => {
  it("keeps the first room-event CLI binding when no binding exists yet", () => {
    const result = {
      payloads: [],
      meta: {
        durationMs: 1,
        agentMeta: {
          sessionId: "new-cli-session",
          provider: "claude-cli",
          model: "claude-opus-4-8",
          cliSessionBinding: {
            sessionId: "new-cli-session",
            authProfileId: "profile",
          },
        },
      },
    } satisfies EmbeddedAgentRunResult;

    expect(keepCliSessionBindingOnlyWhenReused({ result })).toBe(result);
  });

  it("drops a replacement room-event CLI binding when an existing binding was reused", () => {
    const onDroppedReplacement = vi.fn();
    const result = keepCliSessionBindingOnlyWhenReused({
      existingSessionId: "existing-cli-session",
      onDroppedReplacement,
      result: {
        payloads: [],
        meta: {
          durationMs: 1,
          agentMeta: {
            sessionId: "replacement-cli-session",
            provider: "claude-cli",
            model: "claude-opus-4-8",
            cliSessionBinding: {
              sessionId: "replacement-cli-session",
              authProfileId: "profile",
            },
          },
        },
      } satisfies EmbeddedAgentRunResult,
    });

    expect(onDroppedReplacement).toHaveBeenCalledOnce();
    expect(result.meta.agentMeta?.sessionId).toBe("");
    expect(result.meta.agentMeta?.cliSessionBinding).toBeUndefined();
  });
});

describe("createCliToolSummaryTracker", () => {
  const startEvent = {
    name: "exec",
    phase: "start" as const,
    args: { command: "date -u" },
    toolCallId: "tool-1",
  };
  const resultEvent = {
    name: "exec",
    phase: "result" as const,
    args: undefined,
    toolCallId: "tool-1",
    isError: false,
    result: { content: [{ type: "text", text: "Wed Jun 10 2026" }] },
  };

  it("delivers a tool summary for a result using meta captured at start", async () => {
    const deliver = vi.fn();
    const tracker = createCliToolSummaryTracker({
      shouldEmitToolResult: () => true,
      shouldEmitToolOutput: () => false,
      deliver,
    });
    await tracker.noteToolEvent(startEvent);
    await tracker.noteToolEvent(resultEvent);
    expect(deliver).toHaveBeenCalledTimes(1);
    const payload = deliver.mock.calls[0]?.[0] as { text: string; isError?: boolean };
    expect(payload.text).toContain("date -u");
    expect(payload.text).not.toContain("Wed Jun 10 2026");
    expect(payload.isError).toBeUndefined();
  });

  it("appends the tool output block when full verbose output is enabled", async () => {
    const deliver = vi.fn();
    const tracker = createCliToolSummaryTracker({
      shouldEmitToolResult: () => true,
      shouldEmitToolOutput: () => true,
      deliver,
    });
    await tracker.noteToolEvent(startEvent);
    await tracker.noteToolEvent(resultEvent);
    const payload = deliver.mock.calls[0]?.[0] as { text: string };
    expect(payload.text).toContain("```txt");
    expect(payload.text).toContain("Wed Jun 10 2026");
  });

  it("renders top-level structured CLI results in full verbose output", async () => {
    const deliver = vi.fn();
    const tracker = createCliToolSummaryTracker({
      shouldEmitToolResult: () => true,
      shouldEmitToolOutput: () => true,
      deliver,
    });
    await tracker.noteToolEvent(startEvent);
    await tracker.noteToolEvent({
      ...resultEvent,
      result: [{ type: "web_search_result", title: "OpenClaw", url: "https://example.com" }],
    });

    const payload = deliver.mock.calls[0]?.[0] as { text: string };
    expect(payload.text).toContain('"type":"web_search_result"');
    expect(payload.text).toContain('"title":"OpenClaw"');
  });

  it("emits nothing while tool summaries are disabled", async () => {
    const deliver = vi.fn();
    const tracker = createCliToolSummaryTracker({
      shouldEmitToolResult: () => false,
      shouldEmitToolOutput: () => false,
      deliver,
    });
    await tracker.noteToolEvent(startEvent);
    await tracker.noteToolEvent(resultEvent);
    expect(deliver).not.toHaveBeenCalled();
  });

  it("propagates tool errors on the summary payload", async () => {
    const deliver = vi.fn();
    const tracker = createCliToolSummaryTracker({
      shouldEmitToolResult: () => true,
      shouldEmitToolOutput: () => false,
      deliver,
    });
    await tracker.noteToolEvent(startEvent);
    await tracker.noteToolEvent({ ...resultEvent, isError: true });
    const payload = deliver.mock.calls[0]?.[0] as { isError?: boolean };
    expect(payload.isError).toBe(true);
  });

  it("summarizes results without a tracked start event", async () => {
    const deliver = vi.fn();
    const tracker = createCliToolSummaryTracker({
      shouldEmitToolResult: () => true,
      shouldEmitToolOutput: () => false,
      deliver,
    });
    await tracker.noteToolEvent({ ...resultEvent, toolCallId: "unseen" });
    expect(deliver).toHaveBeenCalledTimes(1);
  });
});

describe("runCliAgentWithLifecycle fast auto progress", () => {
  it("emits auto-off after the first CLI tool boundary past the threshold", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const events: Array<{ stream: string; data: Record<string, unknown> }> = [];
    const stop = onAgentEvent((evt) => {
      if (evt.runId === "run-fast-cli") {
        events.push({ stream: evt.stream, data: evt.data });
      }
    });
    const progressPayloads: string[] = [];
    cliDispatchState.runCliAgentMock.mockImplementation(async () => {
      emitAgentEvent({
        runId: "run-fast-cli",
        stream: "tool",
        data: { phase: "start", name: "bash", toolCallId: "call-1" },
      });
      vi.setSystemTime(7_100);
      emitAgentEvent({
        runId: "run-fast-cli",
        stream: "tool",
        data: { phase: "result", name: "bash", toolCallId: "call-1" },
      });
      return {
        payloads: [{ text: "done" }],
        meta: {
          durationMs: 7_100,
          agentMeta: { sessionId: "session-1", provider: "codex-cli", model: "gpt-5.5" },
        },
      } satisfies EmbeddedAgentRunResult;
    });

    await runCliAgentWithLifecycle({
      runId: "run-fast-cli",
      provider: "codex-cli",
      runParams: {
        sessionId: "session-1",
        sessionKey: "agent:main:cli-fast",
        sessionFile: "/tmp/session.jsonl",
        workspaceDir: "/tmp/workspace",
        prompt: "run one tool",
        provider: "codex-cli",
        model: "gpt-5.5",
        timeoutMs: 60_000,
        runId: "run-fast-cli",
        fastMode: "auto",
        fastModeStartedAtMs: 1_000,
        fastModeAutoOnSeconds: 5,
      },
      onFastModeAutoProgress: async (payload) => {
        if (payload.text) {
          progressPayloads.push(payload.text);
        }
      },
    });
    stop();

    const summaries = events
      .filter((event) => event.stream === "item")
      .map((event) => event.data.summary);
    expect(summaries).toContain("💨Fast: auto-off(6s>=5s)");
    expect(summaries).toContain("💨Fast: auto-on");
    expect(progressPayloads).toEqual(["💨Fast: auto-off(6s>=5s)", "💨Fast: auto-on"]);
  });
});
