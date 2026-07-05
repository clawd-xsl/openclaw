import { stat } from "node:fs/promises";
import path from "node:path";
import type {
  PluginStateEntry,
  PluginStateKeyedStore,
} from "openclaw/plugin-sdk/plugin-state-runtime";
import { tempWorkspace } from "openclaw/plugin-sdk/temp-path";
import { describe, expect, it, vi } from "vitest";
import {
  assertEmbeddedRunSucceeded,
  createSessionMemoryFlushArtifact,
  SESSION_MEMORY_FLUSH_RUN_TIMEOUT_MS,
  SessionMemoryFlushService,
  type SessionMemoryFlushServiceDependencies,
} from "./session-memory-flush-service.js";
import {
  createSessionMemoryFlushPlanSnapshot,
  SESSION_MEMORY_FLUSH_PROCESSING_LEASE_MS,
  SessionMemoryFlushRepository,
  type SessionMemoryFlushRecord,
} from "./session-memory-flush-store.js";

function createMemoryStore<T>(): PluginStateKeyedStore<T> {
  const values = new Map<string, PluginStateEntry<T>>();
  return {
    async register(key, value) {
      values.set(key, { key, value, createdAt: Date.now() });
    },
    async registerIfAbsent(key, value) {
      if (values.has(key)) {
        return false;
      }
      values.set(key, { key, value, createdAt: Date.now() });
      return true;
    },
    async update(key, updater) {
      const current = values.get(key);
      const next = updater(current?.value);
      if (next === undefined) {
        return false;
      }
      values.set(key, { key, value: next, createdAt: current?.createdAt ?? Date.now() });
      return true;
    },
    async lookup(key) {
      return values.get(key)?.value;
    },
    async consume(key) {
      const value = values.get(key)?.value;
      values.delete(key);
      return value;
    },
    async delete(key) {
      return values.delete(key);
    },
    async entries() {
      return [...values.values()];
    },
    async clear() {
      values.clear();
    },
  };
}

const runtimeConfig = {
  agents: { list: [{ id: "main", default: true }] },
};

function enqueueInput() {
  return {
    agentId: "main",
    sessionId: "ended-session",
    sessionKey: "agent:main:main",
    endedAt: Date.UTC(2026, 6, 5),
    messageCount: 2,
    sessionFile: "/sessions/ended-session.jsonl",
    transcriptArchived: true,
    plan: createSessionMemoryFlushPlanSnapshot({
      model: "anthropic/claude-sonnet-4-6",
      prompt: "Capture durable memory to disk.",
      systemPrompt: "Write memory to disk.",
      relativePath: "memory/2026-07-05.md",
    }),
  };
}

function createHarness(params?: {
  now?: () => number;
  repository?: SessionMemoryFlushRepository;
  runEmbeddedAgent?: SessionMemoryFlushServiceDependencies["runEmbeddedAgent"];
  transcriptEvents?: unknown[];
}) {
  const repository =
    params?.repository ??
    new SessionMemoryFlushRepository({
      now: params?.now,
      openStore: () => createMemoryStore<SessionMemoryFlushRecord>(),
    });
  const cleanup = vi.fn(async () => undefined);
  const createSessionArtifact = vi.fn(async () => ({
    sessionFile: "/tmp/private/session.jsonl",
    cleanup,
  }));
  const runEmbeddedAgent =
    params?.runEmbeddedAgent ??
    (vi.fn(async () => ({
      meta: {
        durationMs: 10,
        finalAssistantRawText: JSON.stringify({
          kind: "append",
          content: "- Keep the staged migration plan",
        }),
        toolSummary: { calls: 1, tools: ["read"] },
      },
    })) as unknown as SessionMemoryFlushServiceDependencies["runEmbeddedAgent"]);
  const projectCandidate = vi.fn(async (): Promise<"appended" | "reconciled"> => "appended");
  const readBoundedTranscriptEvents = vi.fn(async () => ({
    available: true,
    events: params?.transcriptEvents ?? [
      { type: "message", message: { role: "user", content: "Remember the staged plan" } },
      { type: "message", message: { role: "assistant", content: "I will keep it" } },
    ],
    truncated: false,
  })) as unknown as NonNullable<
    SessionMemoryFlushServiceDependencies["readBoundedTranscriptEvents"]
  >;
  const service = new SessionMemoryFlushService({
    repository,
    getConfig: () => ({ enabled: true, maxPromptTokens: 16_000 }),
    getRuntimeConfig: () => runtimeConfig,
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
    now: params?.now,
    resolveAgentDir: vi.fn(() => "/agents/main"),
    resolveAgentTimeoutMs: vi.fn(() => 48 * 60 * 60 * 1_000),
    resolveAgentWorkspaceDir: vi.fn(() => "/workspace/main"),
    runEmbeddedAgent,
    createSessionArtifact,
    projectCandidate,
    readBoundedTranscriptEvents,
  });
  return {
    cleanup,
    createSessionArtifact,
    projectCandidate,
    readBoundedTranscriptEvents,
    repository,
    runEmbeddedAgent,
    service,
  };
}

async function waitForStatus(
  repository: SessionMemoryFlushRepository,
  status: SessionMemoryFlushRecord["status"],
): Promise<SessionMemoryFlushRecord> {
  let record: SessionMemoryFlushRecord | undefined;
  await vi.waitFor(async () => {
    record = await repository.lookup("main", "ended-session");
    expect(record?.status).toBe(status);
  });
  if (!record) {
    throw new Error("expected memory flush record");
  }
  return record;
}

describe("SessionMemoryFlushService", () => {
  it("creates a private 0700/0600 disposable transcript artifact", async () => {
    const workspace = await tempWorkspace({
      rootDir: "/tmp",
      prefix: "openclaw-session-memory-flush-artifact-",
    });
    try {
      const artifact = await createSessionMemoryFlushArtifact({
        runSessionId: "run-session",
        workspaceDir: workspace.dir,
      });
      if (process.platform !== "win32") {
        expect((await stat(path.dirname(artifact.sessionFile))).mode & 0o777).toBe(0o700);
        expect((await stat(artifact.sessionFile)).mode & 0o777).toBe(0o600);
      }
      await artifact.cleanup();
      await expect(stat(artifact.sessionFile)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await workspace.cleanup();
    }
  });

  it.each([
    {
      name: "aborted run",
      result: { meta: { durationMs: 1, aborted: true, finalAssistantRawText: '{"kind":"noop"}' } },
    },
    {
      name: "terminal error",
      result: {
        meta: {
          durationMs: 1,
          error: { kind: "retry_limit" as const, message: "failed" },
          finalAssistantRawText: '{"kind":"noop"}',
        },
      },
    },
    {
      name: "failure signal",
      result: {
        meta: {
          durationMs: 1,
          failureSignal: {
            kind: "execution_denied" as const,
            source: "tool" as const,
            code: "SYSTEM_RUN_DENIED" as const,
            message: "denied",
            fatalForCron: true as const,
          },
          finalAssistantRawText: '{"kind":"noop"}',
        },
      },
    },
    {
      name: "refusal",
      result: {
        meta: {
          durationMs: 1,
          completion: { refusal: true },
          finalAssistantRawText: '{"kind":"noop"}',
        },
      },
    },
    {
      name: "pending tool",
      result: {
        meta: {
          durationMs: 1,
          pendingToolCalls: [{ id: "call", name: "read", arguments: "{}" }],
          finalAssistantRawText: '{"kind":"noop"}',
        },
      },
    },
    {
      name: "error payload",
      result: {
        meta: { durationMs: 1, finalAssistantRawText: '{"kind":"noop"}' },
        payloads: [{ isError: true, text: "failed" }],
      },
    },
    {
      name: "unexpected tool",
      result: {
        meta: {
          durationMs: 1,
          finalAssistantRawText: '{"kind":"noop"}',
          toolSummary: { calls: 1, tools: ["write"] },
        },
      },
    },
    {
      name: "visible text without raw output",
      result: {
        meta: { durationMs: 1, finalAssistantVisibleText: '{"kind":"noop"}' },
      },
    },
  ])("fails closed on $name", ({ result }) => {
    expect(() =>
      assertEmbeddedRunSucceeded(
        result as Awaited<ReturnType<SessionMemoryFlushServiceDependencies["runEmbeddedAgent"]>>,
      ),
    ).toThrow();
  });

  it("deduplicates concurrent enqueue and runs an isolated read-only Claude-compatible turn", async () => {
    const harness = createHarness();
    await Promise.all([
      harness.service.enqueue(enqueueInput()),
      harness.service.enqueue(enqueueInput()),
    ]);
    const completed = await waitForStatus(harness.repository, "complete");
    expect(harness.runEmbeddedAgent).toHaveBeenCalledTimes(1);
    const call = vi.mocked(harness.runEmbeddedAgent).mock.calls[0]?.[0];
    expect(call).toMatchObject({
      agentId: "main",
      sandboxSessionKey: "agent:main:main",
      workspaceDir: "/workspace/main",
      agentDir: "/agents/main",
      trigger: "memory",
      memoryFlushWritePath: "memory/2026-07-05.md",
      toolsAllow: ["read"],
      disableMessageTool: true,
      allowGatewaySubagentBinding: false,
      cleanupBundleMcpOnRunEnd: true,
      oneShotCliRun: true,
      suppressLiveStreamOutput: true,
      transcriptPrompt: "",
      model: "anthropic/claude-sonnet-4-6",
      modelFallbacksOverride: [],
      sessionFile: "/tmp/private/session.jsonl",
      timeoutMs: SESSION_MEMORY_FLUSH_RUN_TIMEOUT_MS,
    });
    expect(SESSION_MEMORY_FLUSH_PROCESSING_LEASE_MS).toBeGreaterThan(
      SESSION_MEMORY_FLUSH_RUN_TIMEOUT_MS,
    );
    expect(call).not.toHaveProperty("sessionKey");
    expect(call?.sessionId).not.toBe("ended-session");
    expect(call?.runId).not.toBe(call?.sessionId);
    expect(call?.extraSystemPrompt).toContain("host, not the model, owns durable projection");
    expect(harness.projectCandidate).toHaveBeenCalledTimes(1);
    expect(harness.cleanup).toHaveBeenCalledTimes(1);
    expect(completed.candidate).toMatchObject({ kind: "append" });
    await harness.service.stop();
  });

  it("completes an empty extracted transcript as noop without a model or projection", async () => {
    const harness = createHarness({
      transcriptEvents: [{ type: "tool_result", toolName: "read", result: "ignored" }],
    });
    await harness.service.enqueue(enqueueInput());
    const completed = await waitForStatus(harness.repository, "complete");
    expect(completed.candidate).toMatchObject({ kind: "noop" });
    expect(harness.runEmbeddedAgent).not.toHaveBeenCalled();
    expect(harness.projectCandidate).not.toHaveBeenCalled();
    expect(harness.createSessionArtifact).not.toHaveBeenCalled();
    await harness.service.stop();
  });

  it("never projects when candidate persistence fails", async () => {
    const harness = createHarness();
    vi.spyOn(harness.repository, "persistCandidate").mockRejectedValueOnce(
      new Error("candidate store unavailable"),
    );
    await harness.service.enqueue(enqueueInput());
    const failed = await waitForStatus(harness.repository, "failed");
    expect(failed.candidate).toBeNull();
    expect(harness.projectCandidate).not.toHaveBeenCalled();
    expect(harness.cleanup).toHaveBeenCalledTimes(1);
    await harness.service.stop();
  });

  it("recovers append-before-complete failure without regenerating the candidate", async () => {
    let now = 1_000;
    const first = createHarness({ now: () => now });
    const originalMarkComplete = first.repository.markComplete.bind(first.repository);
    vi.spyOn(first.repository, "markComplete")
      .mockRejectedValueOnce(new Error("completion commit unavailable"))
      .mockImplementation(originalMarkComplete);
    await first.service.enqueue(enqueueInput());
    const failed = await waitForStatus(first.repository, "failed");
    expect(failed.candidate).toMatchObject({ kind: "append" });
    expect(first.projectCandidate).toHaveBeenCalledTimes(1);
    expect(first.runEmbeddedAgent).toHaveBeenCalledTimes(1);
    await first.service.stop();

    now = (failed.nextAttemptAt ?? now) + 1;
    const second = createHarness({
      now: () => now,
      repository: first.repository,
      runEmbeddedAgent: first.runEmbeddedAgent,
    });
    second.projectCandidate.mockResolvedValue("reconciled");
    await second.service.start();
    await waitForStatus(second.repository, "complete");
    expect(first.runEmbeddedAgent).toHaveBeenCalledTimes(1);
    expect(second.projectCandidate).toHaveBeenCalledTimes(1);
    await second.service.stop();
  });

  it("aborts, settles, and cleans the private artifact on stop", async () => {
    const runEmbeddedAgent = vi.fn(
      async (call: Parameters<SessionMemoryFlushServiceDependencies["runEmbeddedAgent"]>[0]) =>
        await new Promise<never>((_resolve, reject) => {
          call.abortSignal?.addEventListener(
            "abort",
            () => reject(call.abortSignal?.reason ?? new Error("aborted")),
            { once: true },
          );
        }),
    ) as unknown as SessionMemoryFlushServiceDependencies["runEmbeddedAgent"];
    const harness = createHarness({ runEmbeddedAgent });
    await harness.service.enqueue(enqueueInput());
    await vi.waitFor(() => expect(runEmbeddedAgent).toHaveBeenCalledTimes(1));
    await harness.service.stop();
    expect(harness.cleanup).toHaveBeenCalledTimes(1);
    expect((await harness.repository.lookup("main", "ended-session"))?.status).toBe("pending");
  });

  it("aborts active work and purges durable state when the session is deleted", async () => {
    const runEmbeddedAgent = vi.fn(
      async (call: Parameters<SessionMemoryFlushServiceDependencies["runEmbeddedAgent"]>[0]) =>
        await new Promise<never>((_resolve, reject) => {
          call.abortSignal?.addEventListener(
            "abort",
            () => reject(call.abortSignal?.reason ?? new Error("aborted")),
            { once: true },
          );
        }),
    ) as unknown as SessionMemoryFlushServiceDependencies["runEmbeddedAgent"];
    const harness = createHarness({ runEmbeddedAgent });
    await harness.service.enqueue(enqueueInput());
    await vi.waitFor(() => expect(runEmbeddedAgent).toHaveBeenCalledTimes(1));
    await harness.service.purge("main", "ended-session");
    await vi.waitFor(() => expect(harness.cleanup).toHaveBeenCalledTimes(1));
    expect(await harness.repository.lookup("main", "ended-session")).toBeUndefined();
    await harness.service.stop();
  });
});
