// Memory Core plugin module resolves bounded session-summary configuration.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";

export type SessionSummariesConfig = {
  enabled: boolean;
  model?: string;
  autoInject: boolean;
  lookbackDays: number;
  maxPromptTokens: number;
  minMessages: number;
};

export const SESSION_SUMMARIES_CONFIG_BOUNDS = {
  lookbackDays: { min: 1, max: 3_650 },
  maxPromptTokens: { min: 1_024, max: 65_536 },
  minMessages: { min: 1, max: 1_000 },
} as const;

export const DEFAULT_SESSION_SUMMARIES_CONFIG: SessionSummariesConfig = {
  // Preserve the custom branch's continuity behavior while keeping every model
  // call and prompt injection bounded. Operators can still opt out explicitly.
  enabled: true,
  autoInject: true,
  lookbackDays: 30,
  maxPromptTokens: 16_000,
  minMessages: 3,
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

function readModel(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= 256 ? normalized : undefined;
}

export function resolveSessionSummariesConfig(params?: {
  cfg?: OpenClawConfig;
  pluginConfig?: Record<string, unknown>;
}): SessionSummariesConfig {
  const pluginConfig = params?.pluginConfig ?? resolveOwnedPluginConfig(params?.cfg);
  const summaries = asRecord(pluginConfig?.summaries);
  const model = readModel(summaries?.model);

  return {
    enabled:
      typeof summaries?.enabled === "boolean"
        ? summaries.enabled
        : DEFAULT_SESSION_SUMMARIES_CONFIG.enabled,
    ...(model ? { model } : {}),
    autoInject:
      typeof summaries?.autoInject === "boolean"
        ? summaries.autoInject
        : DEFAULT_SESSION_SUMMARIES_CONFIG.autoInject,
    lookbackDays: readBoundedInteger(
      summaries?.lookbackDays,
      SESSION_SUMMARIES_CONFIG_BOUNDS.lookbackDays,
      DEFAULT_SESSION_SUMMARIES_CONFIG.lookbackDays,
    ),
    maxPromptTokens: readBoundedInteger(
      summaries?.maxPromptTokens,
      SESSION_SUMMARIES_CONFIG_BOUNDS.maxPromptTokens,
      DEFAULT_SESSION_SUMMARIES_CONFIG.maxPromptTokens,
    ),
    minMessages: readBoundedInteger(
      summaries?.minMessages,
      SESSION_SUMMARIES_CONFIG_BOUNDS.minMessages,
      DEFAULT_SESSION_SUMMARIES_CONFIG.minMessages,
    ),
  };
}
