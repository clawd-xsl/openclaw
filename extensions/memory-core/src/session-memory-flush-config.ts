// Memory Core plugin module resolves completed-session memory-flush configuration.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";

export type CompletedSessionMemoryFlushConfig = {
  enabled: boolean;
  maxPromptTokens: number;
};

export const COMPLETED_SESSION_MEMORY_FLUSH_CONFIG_BOUNDS = {
  maxPromptTokens: { min: 1_024, max: 65_536 },
} as const;

export const DEFAULT_COMPLETED_SESSION_MEMORY_FLUSH_CONFIG: CompletedSessionMemoryFlushConfig = {
  enabled: true,
  maxPromptTokens: 16_000,
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function resolveOwnedPluginConfig(
  cfg: OpenClawConfig | undefined,
): Record<string, unknown> | undefined {
  const root = asRecord(cfg);
  const plugins = asRecord(root?.plugins);
  const entries = asRecord(plugins?.entries);
  const memoryCore = asRecord(entries?.["memory-core"]);
  return asRecord(memoryCore?.config);
}

function readBoundedInteger(
  value: unknown,
  bounds: { min: number; max: number },
  fallback: number,
): number {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= bounds.min &&
    value <= bounds.max
    ? value
    : fallback;
}

export function resolveCompletedSessionMemoryFlushConfig(params?: {
  cfg?: OpenClawConfig;
  pluginConfig?: Record<string, unknown>;
}): CompletedSessionMemoryFlushConfig {
  const pluginConfig = params?.pluginConfig ?? resolveOwnedPluginConfig(params?.cfg);
  const completedSessionFlush = asRecord(pluginConfig?.completedSessionFlush);
  return {
    enabled:
      typeof completedSessionFlush?.enabled === "boolean"
        ? completedSessionFlush.enabled
        : DEFAULT_COMPLETED_SESSION_MEMORY_FLUSH_CONFIG.enabled,
    maxPromptTokens: readBoundedInteger(
      completedSessionFlush?.maxPromptTokens,
      COMPLETED_SESSION_MEMORY_FLUSH_CONFIG_BOUNDS.maxPromptTokens,
      DEFAULT_COMPLETED_SESSION_MEMORY_FLUSH_CONFIG.maxPromptTokens,
    ),
  };
}
