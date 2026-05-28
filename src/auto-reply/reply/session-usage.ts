import {
  clearCliSession,
  setCliSessionBinding,
  setCliSessionId,
} from "../../agents/cli-session.js";
import {
  normalizeStoredOverrideModel,
  resolveDefaultModelForAgent,
  resolvePersistedSelectedModelRef,
} from "../../agents/model-selection.js";
import {
  deriveSessionTotalTokens,
  hasNonzeroUsage,
  type NormalizedUsage,
} from "../../agents/usage.js";
import { loadConfig } from "../../config/config.js";
import {
  type SessionSystemPromptReport,
  type SessionEntry,
  queueSessionStoreColdBackfill,
  writeHotSessionEntry,
} from "../../config/sessions.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { logVerbose } from "../../globals.js";
import { createTimingTrace } from "../../infra/timing-trace.js";
import { resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import { normalizeOptionalLowercaseString } from "../../shared/string-coerce.js";
import { estimateUsageCost, resolveModelCostConfig } from "../../utils/usage-format.js";

function applyCliSessionIdToSessionPatch(
  params: {
    providerUsed?: string;
    cliSessionId?: string;
    cliSessionBinding?: import("../../config/sessions.js").CliSessionBinding;
    clearCliSession?: boolean;
  },
  entry: SessionEntry,
  patch: Partial<SessionEntry>,
): Partial<SessionEntry> {
  const cliProvider = params.providerUsed ?? entry.modelProvider;
  if (params.clearCliSession && cliProvider) {
    const nextEntry = { ...entry, ...patch };
    clearCliSession(nextEntry, cliProvider);
    return {
      ...patch,
      cliSessionIds: nextEntry.cliSessionIds,
      cliSessionBindings: nextEntry.cliSessionBindings,
      claudeCliSessionId: nextEntry.claudeCliSessionId,
    };
  }
  if (params.cliSessionBinding && cliProvider) {
    const nextEntry = { ...entry, ...patch };
    setCliSessionBinding(nextEntry, cliProvider, params.cliSessionBinding);
    return {
      ...patch,
      cliSessionIds: nextEntry.cliSessionIds,
      cliSessionBindings: nextEntry.cliSessionBindings,
      claudeCliSessionId: nextEntry.claudeCliSessionId,
    };
  }
  if (params.cliSessionId && cliProvider) {
    const nextEntry = { ...entry, ...patch };
    setCliSessionId(nextEntry, cliProvider, params.cliSessionId);
    return {
      ...patch,
      cliSessionIds: nextEntry.cliSessionIds,
      cliSessionBindings: nextEntry.cliSessionBindings,
      claudeCliSessionId: nextEntry.claudeCliSessionId,
    };
  }
  return patch;
}

function resolveNonNegativeNumber(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function estimateSessionRunCostUsd(params: {
  cfg: OpenClawConfig;
  usage?: NormalizedUsage;
  providerUsed?: string;
  modelUsed?: string;
}): number | undefined {
  if (!hasNonzeroUsage(params.usage)) {
    return undefined;
  }
  const cost = resolveModelCostConfig({
    provider: params.providerUsed,
    model: params.modelUsed,
    config: params.cfg,
  });
  return resolveNonNegativeNumber(estimateUsageCost({ usage: params.usage, cost }));
}

export type PersistSessionUsageUpdateParams = {
  storePath?: string;
  sessionKey?: string;
  cfg?: OpenClawConfig;
  usage?: NormalizedUsage;
  /**
   * Usage from the last individual API call (not accumulated). When provided,
   * this is used for `totalTokens` instead of the accumulated `usage` so that
   * context-window utilization reflects the actual current context size rather
   * than the sum of input tokens across all API calls in the run.
   */
  lastCallUsage?: NormalizedUsage;
  modelUsed?: string;
  providerUsed?: string;
  contextTokensUsed?: number;
  promptTokens?: number;
  usageIsContextSnapshot?: boolean;
  systemPromptReport?: SessionSystemPromptReport;
  cliSessionId?: string;
  cliSessionBinding?: import("../../config/sessions.js").CliSessionBinding;
  clearCliSession?: boolean;
  logLabel?: string;
};

function createPersistSessionUsageTrace(
  params: Pick<PersistSessionUsageUpdateParams, "logLabel" | "sessionKey">,
  scope: string,
) {
  return createTimingTrace({
    channel: "reply-trace",
    label: params.logLabel ?? params.sessionKey ?? "unknown",
    scope,
  });
}

function hasFreshContextSnapshot(params: PersistSessionUsageUpdateParams): boolean {
  const hasPromptTokens =
    typeof params.promptTokens === "number" &&
    Number.isFinite(params.promptTokens) &&
    params.promptTokens > 0;
  const providerId = normalizeOptionalLowercaseString(params.providerUsed);
  // Claude CLI usage reflects provider-owned hidden session continuity, which
  // can drift from OpenClaw's transcript-based session model. Do not promote
  // those usage numbers to a "fresh" OpenClaw context snapshot.
  const claudeCliSessionContinuity = providerId?.startsWith("claude-cli") === true;
  const usageSnapshotAllowed =
    params.usageIsContextSnapshot === true && !claudeCliSessionContinuity;
  return Boolean(params.lastCallUsage) || hasPromptTokens || usageSnapshotAllowed;
}

function resolvePendingLiveSwitchSelection(
  params: PersistSessionUsageUpdateParams,
  entry: SessionEntry,
): { provider: string; model: string } | null {
  if (!entry.liveModelSwitchPending) {
    return null;
  }

  const normalizedSelection = normalizeStoredOverrideModel({
    providerOverride: entry.providerOverride,
    modelOverride: entry.modelOverride,
  });
  const cfg = params.cfg ?? loadConfig();
  const agentId = resolveAgentIdFromSessionKey(params.sessionKey);
  const defaultModelRef = resolveDefaultModelForAgent({
    cfg,
    agentId,
  });
  return (
    resolvePersistedSelectedModelRef({
      defaultProvider: defaultModelRef.provider,
      overrideProvider: normalizedSelection.providerOverride,
      overrideModel: normalizedSelection.modelOverride,
    }) ?? defaultModelRef
  );
}

function buildSessionContinuityPatch(
  params: PersistSessionUsageUpdateParams,
  entry: SessionEntry,
): Partial<SessionEntry> | null {
  const patch: Partial<SessionEntry> = {};
  const nextProvider = params.providerUsed ?? entry.modelProvider;
  const nextModel = params.modelUsed ?? entry.model;
  const nextContextTokens = params.contextTokensUsed ?? entry.contextTokens;
  const pendingLiveSwitchSelection = resolvePendingLiveSwitchSelection(params, entry);
  const preservePendingSelection =
    pendingLiveSwitchSelection != null &&
    (normalizeOptionalLowercaseString(nextProvider) !==
      normalizeOptionalLowercaseString(pendingLiveSwitchSelection.provider) ||
      normalizeOptionalLowercaseString(nextModel) !==
        normalizeOptionalLowercaseString(pendingLiveSwitchSelection.model));

  if (!preservePendingSelection) {
    if (nextProvider !== entry.modelProvider) {
      patch.modelProvider = nextProvider;
    }
    if (nextModel !== entry.model) {
      patch.model = nextModel;
    }
    if (nextContextTokens !== entry.contextTokens) {
      patch.contextTokens = nextContextTokens;
    }
  }

  const cliProvider = params.providerUsed ?? entry.modelProvider;
  if (params.clearCliSession && cliProvider) {
    return applyCliSessionIdToSessionPatch(params, entry, {
      ...patch,
      updatedAt: Date.now(),
    });
  }
  if (params.cliSessionBinding && cliProvider) {
    const existingBinding = entry.cliSessionBindings?.[cliProvider];
    if (JSON.stringify(existingBinding) !== JSON.stringify(params.cliSessionBinding)) {
      return applyCliSessionIdToSessionPatch(params, entry, {
        ...patch,
        updatedAt: Date.now(),
      });
    }
  }
  if (params.cliSessionId && cliProvider) {
    const existingSessionId = entry.cliSessionIds?.[cliProvider];
    if (existingSessionId !== params.cliSessionId) {
      return applyCliSessionIdToSessionPatch(params, entry, {
        ...patch,
        updatedAt: Date.now(),
      });
    }
  }

  if (Object.keys(patch).length === 0) {
    return null;
  }
  return { ...patch, updatedAt: Date.now() };
}

function buildSessionAccountingPatch(
  params: PersistSessionUsageUpdateParams,
  entry: SessionEntry,
  cfg: OpenClawConfig,
): Partial<SessionEntry> | null {
  const hasUsage = hasNonzeroUsage(params.usage);
  const freshContextSnapshot = hasFreshContextSnapshot(params);
  if (!hasUsage && !freshContextSnapshot && !params.systemPromptReport) {
    return null;
  }

  const patch: Partial<SessionEntry> = {};
  if (params.systemPromptReport) {
    patch.systemPromptReport = params.systemPromptReport;
  }
  if (hasUsage) {
    patch.inputTokens = params.usage?.input ?? 0;
    patch.outputTokens = params.usage?.output ?? 0;
    const cacheUsage = params.lastCallUsage ?? params.usage;
    patch.cacheRead = cacheUsage?.cacheRead ?? 0;
    patch.cacheWrite = cacheUsage?.cacheWrite ?? 0;
  }
  const runEstimatedCostUsd = estimateSessionRunCostUsd({
    cfg,
    usage: params.usage,
    providerUsed: params.providerUsed ?? entry.modelProvider,
    modelUsed: params.modelUsed ?? entry.model,
  });
  if (runEstimatedCostUsd !== undefined) {
    const existingEstimatedCostUsd = resolveNonNegativeNumber(entry.estimatedCostUsd) ?? 0;
    patch.estimatedCostUsd = existingEstimatedCostUsd + runEstimatedCostUsd;
  }

  if (hasUsage || freshContextSnapshot) {
    const resolvedContextTokens = params.contextTokensUsed ?? entry.contextTokens;
    const usageForContext =
      params.lastCallUsage ?? (params.usageIsContextSnapshot === true ? params.usage : undefined);
    patch.totalTokens = freshContextSnapshot
      ? deriveSessionTotalTokens({
          usage: usageForContext,
          contextTokens: resolvedContextTokens,
          promptTokens: params.promptTokens,
        })
      : undefined;
    patch.totalTokensFresh = typeof patch.totalTokens === "number";
  }
  return patch;
}

export async function persistSessionContinuityUpdate(
  params: PersistSessionUsageUpdateParams,
): Promise<void> {
  const { storePath, sessionKey } = params;
  if (!storePath || !sessionKey) {
    return;
  }

  const label = params.logLabel ? `${params.logLabel} ` : "";
  const trace = createPersistSessionUsageTrace(params, "persistSessionContinuityUpdate");
  try {
    trace("update-start");
    const next = await writeHotSessionEntry({
      storePath,
      sessionKey,
      createIfMissing: false,
      mutator: async (entry) => {
        const patch = entry ? buildSessionContinuityPatch(params, entry) : null;
        return entry && patch ? { ...entry, ...patch } : (entry ?? null);
      },
    });
    if (next) {
      queueSessionStoreColdBackfill({ storePath, sessionKey, entry: next });
    }
    trace("update-done");
  } catch (err) {
    logVerbose(`failed to persist ${label}session continuity update: ${String(err)}`);
  }
}

export async function persistSessionAccountingUpdate(
  params: PersistSessionUsageUpdateParams,
): Promise<void> {
  const { storePath, sessionKey } = params;
  if (!storePath || !sessionKey) {
    return;
  }

  const label = params.logLabel ? `${params.logLabel} ` : "";
  const trace = createPersistSessionUsageTrace(params, "persistSessionAccountingUpdate");
  const cfg = params.cfg ?? loadConfig();
  const hasUsage = hasNonzeroUsage(params.usage);
  const freshContextSnapshot = hasFreshContextSnapshot(params);

  if (hasUsage || freshContextSnapshot || params.systemPromptReport) {
    try {
      trace(
        "update-start",
        `hasUsage=${hasUsage ? "yes" : "no"} freshContext=${freshContextSnapshot ? "yes" : "no"}`,
      );
      const next = await writeHotSessionEntry({
        storePath,
        sessionKey,
        createIfMissing: false,
        mutator: async (entry) => {
          const patch = entry ? buildSessionAccountingPatch(params, entry, cfg) : null;
          return entry && patch ? { ...entry, ...patch } : (entry ?? null);
        },
      });
      if (next) {
        queueSessionStoreColdBackfill({ storePath, sessionKey, entry: next });
      }
      trace("update-done");
    } catch (err) {
      logVerbose(`failed to persist ${label}session accounting update: ${String(err)}`);
    }
    return;
  }
}

export async function persistSessionUsageUpdate(
  params: PersistSessionUsageUpdateParams,
): Promise<void> {
  await persistSessionContinuityUpdate(params);
  await persistSessionAccountingUpdate(params);
}
