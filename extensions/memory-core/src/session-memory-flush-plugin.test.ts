import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isDefaultAgentMainSession,
  registerCompletedSessionMemoryFlush,
} from "./session-memory-flush-plugin.js";
import { SessionMemoryFlushService } from "./session-memory-flush-service.js";

type SessionEndHook = (
  event: {
    sessionId: string;
    sessionKey?: string;
    messageCount: number;
    reason?:
      | "new"
      | "reset"
      | "idle"
      | "daily"
      | "compaction"
      | "deleted"
      | "shutdown"
      | "restart"
      | "unknown";
    sessionFile?: string;
    transcriptArchived?: boolean;
  },
  ctx: { agentId?: string; sessionId: string; sessionKey?: string },
) => Promise<void> | void;

function createConfig(params?: {
  enabled?: boolean;
  global?: boolean;
  killSwitch?: boolean;
}): OpenClawConfig {
  return {
    agents: {
      defaults: {
        userTimezone: "UTC",
        compaction: {
          memoryFlush: { enabled: params?.killSwitch !== false },
        },
      },
      list: [{ id: "primary", default: true }, { id: "other" }],
    },
    session: {
      scope: params?.global ? "global" : "per-sender",
      mainKey: "home",
    },
    plugins: {
      entries: {
        "memory-core": {
          config: {
            completedSessionFlush: { enabled: params?.enabled ?? true },
          },
        },
      },
    },
  };
}

function registerHarness(cfg: OpenClawConfig, now = Date.UTC(2026, 6, 5, 12)) {
  const hooks = new Map<string, unknown>();
  let registeredService: Parameters<OpenClawPluginApi["registerService"]>[0] | undefined;
  const runtime = {
    config: { current: () => cfg },
    state: { openKeyedStore: vi.fn() },
    agent: {
      runEmbeddedAgent: vi.fn(),
      resolveAgentDir: vi.fn(() => "/agents/primary"),
      resolveAgentTimeoutMs: vi.fn(() => 600_000),
      resolveAgentWorkspaceDir: vi.fn(() => "/workspace/primary"),
    },
  } as unknown as OpenClawPluginApi["runtime"];
  const api = createTestPluginApi({
    id: "memory-core",
    config: cfg,
    pluginConfig: cfg.plugins?.entries?.["memory-core"]?.config,
    runtime,
    on(name, handler) {
      hooks.set(name, handler);
    },
    registerService(service) {
      registeredService = service;
    },
  });
  const service = registerCompletedSessionMemoryFlush(api, { now: () => now });
  return {
    hook: hooks.get("session_end") as SessionEndHook,
    registeredService: () => registeredService,
    service,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("completed-session memory flush plugin", () => {
  it("recognizes only the dynamic default agent main/global session", () => {
    const scoped = createConfig();
    expect(
      isDefaultAgentMainSession({
        agentId: "primary",
        cfg: scoped,
        sessionKey: "agent:primary:home",
      }),
    ).toBe(true);
    expect(
      isDefaultAgentMainSession({
        agentId: "other",
        cfg: scoped,
        sessionKey: "agent:other:home",
      }),
    ).toBe(false);
    expect(
      isDefaultAgentMainSession({
        agentId: "primary",
        cfg: scoped,
        sessionKey: "agent:primary:thread",
      }),
    ).toBe(false);
    const global = createConfig({ global: true });
    expect(
      isDefaultAgentMainSession({ agentId: "primary", cfg: global, sessionKey: "global" }),
    ).toBe(true);
  });

  it("handles rollover reasons, permits real rollover after compaction, and freezes the endedAt plan", async () => {
    const enqueue = vi
      .spyOn(SessionMemoryFlushService.prototype, "enqueue")
      .mockResolvedValue(undefined);
    const purge = vi
      .spyOn(SessionMemoryFlushService.prototype, "purge")
      .mockResolvedValue(undefined);
    const endedAt = Date.UTC(2026, 6, 5, 12);
    const harness = registerHarness(createConfig(), endedAt);
    expect(harness.registeredService()?.id).toBe("memory-core-completed-session-flush");

    for (const reason of ["shutdown", "restart", "unknown"] as const) {
      await harness.hook(
        { sessionId: `skip-${reason}`, messageCount: 2, reason },
        { agentId: "primary", sessionId: `skip-${reason}`, sessionKey: "agent:primary:home" },
      );
    }
    await harness.hook(
      { sessionId: "compacted", messageCount: 2, reason: "compaction" },
      { agentId: "primary", sessionId: "compacted", sessionKey: "agent:primary:home" },
    );
    await harness.hook(
      { sessionId: "compacted", messageCount: 2, reason: "new" },
      { agentId: "primary", sessionId: "compacted", sessionKey: "agent:primary:home" },
    );
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue.mock.calls[0]?.[0]).toMatchObject({ sessionId: "compacted" });

    for (const reason of ["new", "reset", "idle", "daily"] as const) {
      await harness.hook(
        {
          sessionId: `flush-${reason}`,
          messageCount: 3,
          reason,
          sessionFile: `/sessions/${reason}.jsonl`,
          transcriptArchived: true,
        },
        { agentId: "primary", sessionId: `flush-${reason}`, sessionKey: "agent:primary:home" },
      );
    }
    expect(enqueue).toHaveBeenCalledTimes(5);
    const newRollover = enqueue.mock.calls.find(([input]) => input.sessionId === "flush-new")?.[0];
    expect(newRollover).toMatchObject({
      endedAt,
      plan: { relativePath: "memory/2026-07-05.md" },
      sessionFile: "/sessions/new.jsonl",
      transcriptArchived: true,
    });

    await harness.hook(
      { sessionId: "deleted", messageCount: 0, reason: "deleted" },
      { sessionId: "deleted" },
    );
    expect(purge).toHaveBeenCalledWith("primary", "deleted");
  });

  it("honors explicit disable, the total kill switch, and non-main scope", async () => {
    const enqueue = vi
      .spyOn(SessionMemoryFlushService.prototype, "enqueue")
      .mockResolvedValue(undefined);
    for (const cfg of [createConfig({ enabled: false }), createConfig({ killSwitch: false })]) {
      const harness = registerHarness(cfg);
      await harness.hook(
        { sessionId: "disabled", messageCount: 2, reason: "new" },
        { agentId: "primary", sessionId: "disabled", sessionKey: "agent:primary:home" },
      );
    }
    const harness = registerHarness(createConfig());
    await harness.hook(
      { sessionId: "other", messageCount: 2, reason: "new" },
      { agentId: "other", sessionId: "other", sessionKey: "agent:other:home" },
    );
    await harness.hook(
      { sessionId: "thread", messageCount: 2, reason: "new" },
      { agentId: "primary", sessionId: "thread", sessionKey: "agent:primary:thread" },
    );
    expect(enqueue).not.toHaveBeenCalled();
  });
});
