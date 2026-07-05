// Memory Core plugin module registers completed-session memory flushing.
import path from "node:path";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import {
  resolveDefaultAgentId,
  resolveSessionAgentId,
  resolveStateDir,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import type {
  OpenKeyedStoreOptions,
  PluginStateKeyedStore,
} from "openclaw/plugin-sdk/plugin-state-runtime";
import { buildAgentMainSessionKey } from "openclaw/plugin-sdk/routing";
import { canonicalizeMainSessionAlias } from "openclaw/plugin-sdk/session-store-runtime";
import { buildMemoryFlushPlan } from "./flush-plan.js";
import {
  resolveCompletedSessionMemoryFlushConfig,
  type CompletedSessionMemoryFlushConfig,
} from "./session-memory-flush-config.js";
import { SessionMemoryFlushService } from "./session-memory-flush-service.js";
import {
  createSessionMemoryFlushPlanSnapshot,
  SESSION_MEMORY_FLUSH_STORE_MAX_ENTRIES,
  SessionMemoryFlushRepository,
  type SessionMemoryFlushRecord,
} from "./session-memory-flush-store.js";

export type RegisterCompletedSessionMemoryFlushOptions = {
  now?: () => number;
  store?: PluginStateKeyedStore<SessionMemoryFlushRecord>;
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readCurrentConfig(api: OpenClawPluginApi): OpenClawConfig {
  return (api.runtime.config?.current?.() ?? api.config) as OpenClawConfig;
}

function resolveCurrentFlushConfig(
  api: OpenClawPluginApi,
  cfg: OpenClawConfig = readCurrentConfig(api),
): CompletedSessionMemoryFlushConfig {
  const resolved = resolveCompletedSessionMemoryFlushConfig({
    cfg,
    pluginConfig:
      asRecord(cfg.plugins?.entries?.["memory-core"]?.config) ?? asRecord(api.pluginConfig),
  });
  return cfg.agents?.defaults?.compaction?.memoryFlush?.enabled === false
    ? { ...resolved, enabled: false }
    : resolved;
}

export function isDefaultAgentMainSession(params: {
  agentId: string;
  cfg: OpenClawConfig;
  sessionKey: string;
}): boolean {
  const defaultAgentId = resolveDefaultAgentId(params.cfg);
  if (params.agentId.trim().toLowerCase() !== defaultAgentId.trim().toLowerCase()) {
    return false;
  }
  const canonical = canonicalizeMainSessionAlias({
    cfg: params.cfg,
    agentId: defaultAgentId,
    sessionKey: params.sessionKey,
  });
  const expected =
    params.cfg.session?.scope === "global"
      ? "global"
      : buildAgentMainSessionKey({
          agentId: defaultAgentId,
          mainKey: params.cfg.session?.mainKey,
        });
  return canonical === expected;
}

function isFlushRolloverReason(reason: string): boolean {
  return reason === "new" || reason === "reset" || reason === "idle" || reason === "daily";
}

export function registerCompletedSessionMemoryFlush(
  api: OpenClawPluginApi,
  options: RegisterCompletedSessionMemoryFlushOptions = {},
): SessionMemoryFlushService {
  const now = options.now ?? Date.now;
  const repository = new SessionMemoryFlushRepository({
    now,
    openStore: () =>
      options.store ??
      api.runtime.state.openKeyedStore({
        namespace: "completed-session-memory-flush",
        maxEntries: SESSION_MEMORY_FLUSH_STORE_MAX_ENTRIES,
      } satisfies OpenKeyedStoreOptions),
  });
  const service = new SessionMemoryFlushService({
    repository,
    getConfig: () => resolveCurrentFlushConfig(api),
    getRuntimeConfig: () => readCurrentConfig(api),
    logger: api.logger,
    now,
    projectionLockDir: path.join(resolveStateDir(), "memory", "completed-session-flush-locks"),
    runEmbeddedAgent: api.runtime.agent.runEmbeddedAgent,
    resolveAgentDir: api.runtime.agent.resolveAgentDir,
    resolveAgentTimeoutMs: api.runtime.agent.resolveAgentTimeoutMs,
    resolveAgentWorkspaceDir: api.runtime.agent.resolveAgentWorkspaceDir,
  });
  api.on("session_end", async (event, ctx) => {
    const reason = event.reason ?? "unknown";
    if (reason === "compaction") {
      return;
    }
    const cfg = readCurrentConfig(api);
    const sessionKey = (ctx.sessionKey ?? event.sessionKey)?.trim();
    const agentId =
      ctx.agentId?.trim() ||
      (sessionKey ? resolveSessionAgentId({ sessionKey, config: cfg }) : undefined);
    if (reason === "deleted") {
      await service.purge(agentId ?? resolveDefaultAgentId(cfg), event.sessionId);
      return;
    }
    if (!isFlushRolloverReason(reason)) {
      return;
    }
    if (!agentId || !sessionKey || !isDefaultAgentMainSession({ agentId, cfg, sessionKey })) {
      return;
    }
    const flushConfig = resolveCurrentFlushConfig(api, cfg);
    if (!flushConfig.enabled) {
      return;
    }
    // The existing compaction memory-flush kill switch governs every memory-flush path.
    const endedAt = now();
    const plan = buildMemoryFlushPlan({ cfg, nowMs: endedAt });
    if (!plan) {
      return;
    }
    await service.enqueue({
      agentId,
      sessionId: event.sessionId,
      sessionKey,
      endedAt,
      messageCount: event.messageCount,
      plan: createSessionMemoryFlushPlanSnapshot(plan),
      ...(event.sessionFile ? { sessionFile: event.sessionFile } : {}),
      ...(event.transcriptArchived !== undefined
        ? { transcriptArchived: event.transcriptArchived }
        : {}),
    });
  });

  api.registerService({
    id: "memory-core-completed-session-flush",
    start: async () => {
      try {
        await service.start();
      } catch (error) {
        api.logger.warn(
          `memory-core: completed-session memory-flush recovery failed: ${formatErrorMessage(error)}`,
        );
      }
    },
    stop: async () => {
      await service.stop();
    },
  });

  return service;
}
