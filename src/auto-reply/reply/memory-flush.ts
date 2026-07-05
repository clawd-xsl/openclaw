// Builds memory flush prompts when conversation context exceeds model budget.
import { resolveContextTokensForModel } from "../../agents/context.js";
import { DEFAULT_CONTEXT_TOKENS } from "../../agents/defaults.js";
import { legacyModelKey, modelKey } from "../../agents/model-selection-normalize.js";
import { parseNonNegativeByteSize } from "../../config/byte-size.js";
import { resolveFreshSessionTotalTokens, type SessionEntry } from "../../config/sessions.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";

export function resolveMemoryFlushContextWindowTokens(params: {
  modelId?: string;
  agentCfgContextTokens?: number;
  cfg?: OpenClawConfig;
  provider?: string;
}): number {
  return (
    resolveContextTokensForModel({
      cfg: params.cfg,
      provider: params.provider,
      model: params.modelId,
      contextTokensOverride: params.agentCfgContextTokens,
      allowAsyncLoad: false,
    }) ?? DEFAULT_CONTEXT_TOKENS
  );
}

export function resolveMaxActiveTranscriptBytes(cfg?: OpenClawConfig): number | undefined {
  const compaction = cfg?.agents?.defaults?.compaction;
  if (compaction?.truncateAfterCompaction !== true) {
    return undefined;
  }
  const parsed = parseNonNegativeByteSize(compaction.maxActiveTranscriptBytes);
  return typeof parsed === "number" && parsed > 0 ? parsed : undefined;
}

function resolvePositiveTokenCount(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined;
}

function resolveNonNegativeInteger(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function resolveBooleanParam(sources: Array<Record<string, unknown> | undefined>, key: string) {
  for (const source of sources.toReversed()) {
    const value = source?.[key];
    if (typeof value === "boolean") {
      return value;
    }
  }
  return undefined;
}

function resolvePositiveIntegerParam(
  sources: Array<Record<string, unknown> | undefined>,
  key: string,
): number | undefined {
  for (const source of sources.toReversed()) {
    const value = source?.[key];
    if (typeof value === "number" && Number.isFinite(value) && value > 0) {
      return Math.floor(value);
    }
  }
  return undefined;
}

export function resolveResponsesServerCompactionThreshold(params: {
  cfg?: OpenClawConfig;
  provider?: string;
  modelId?: string;
}): number | undefined {
  const provider = params.provider?.trim();
  const modelId = params.modelId?.trim();
  if (!provider || !modelId) {
    return undefined;
  }
  const legacyKey = legacyModelKey(provider, modelId);
  const providerConfig = params.cfg?.models?.providers?.[provider];
  const modelConfig =
    params.cfg?.agents?.defaults?.models?.[modelKey(provider, modelId)] ??
    (legacyKey ? params.cfg?.agents?.defaults?.models?.[legacyKey] : undefined);
  const providerModelConfig = providerConfig?.models?.find((entry) => entry.id === modelId);
  const sources = [
    asRecord(providerConfig?.params),
    asRecord(providerModelConfig?.params),
    asRecord(params.cfg?.agents?.defaults?.params),
    asRecord(modelConfig?.params),
  ];
  const serverCompaction = resolveBooleanParam(sources, "responsesServerCompaction");
  const serverCompactionEnabled =
    provider === "openai" ? serverCompaction !== false : serverCompaction === true;
  if (!serverCompactionEnabled) {
    return undefined;
  }
  return resolvePositiveIntegerParam(sources, "responsesCompactThreshold");
}

function resolveMemoryFlushGateState<
  TEntry extends Pick<SessionEntry, "totalTokens" | "totalTokensFresh">,
>(params: {
  entry?: TEntry;
  tokenCount?: number;
  contextWindowTokens: number;
  reserveTokensFloor: number;
  softThresholdTokens: number;
  minimumThresholdTokens?: number;
}): { entry: TEntry; totalTokens: number; threshold: number } | null {
  if (!params.entry) {
    return null;
  }

  const totalTokens =
    resolvePositiveTokenCount(params.tokenCount) ?? resolveFreshSessionTotalTokens(params.entry);
  if (!totalTokens || totalTokens <= 0) {
    return null;
  }

  const contextWindow = Math.max(1, Math.floor(params.contextWindowTokens));
  const reserveTokens = Math.max(0, Math.floor(params.reserveTokensFloor));
  const softThreshold = Math.max(0, Math.floor(params.softThresholdTokens));
  const threshold = Math.max(
    0,
    contextWindow - reserveTokens - softThreshold,
    Math.floor(params.minimumThresholdTokens ?? 0),
  );
  if (threshold <= 0) {
    return null;
  }

  return { entry: params.entry, totalTokens, threshold };
}

export function shouldRunMemoryFlush(params: {
  entry?: Pick<
    SessionEntry,
    "totalTokens" | "totalTokensFresh" | "compactionCount" | "memoryFlushCompactionCount"
  >;
  /**
   * Optional token count override for flush gating. When provided, this value is
   * treated as a fresh context snapshot and used instead of the cached
   * SessionEntry.totalTokens (which may be stale/unknown).
   */
  tokenCount?: number;
  contextWindowTokens: number;
  reserveTokensFloor: number;
  softThresholdTokens: number;
}): boolean {
  const state = resolveMemoryFlushGateState(params);
  if (!state || state.totalTokens < state.threshold) {
    return false;
  }

  if (hasAlreadyFlushedForCurrentCompaction(state.entry)) {
    return false;
  }

  return true;
}

export function shouldRunPreflightCompaction(params: {
  entry?: Pick<SessionEntry, "totalTokens" | "totalTokensFresh">;
  /**
   * Optional projected token count override for pre-run compaction gating.
   * When provided, this value is treated as a fresh estimate and used instead
   * of any cached SessionEntry total.
   */
  tokenCount?: number;
  contextWindowTokens: number;
  reserveTokensFloor: number;
  softThresholdTokens: number;
  minimumThresholdTokens?: number;
}): boolean {
  const state = resolveMemoryFlushGateState(params);
  return Boolean(state && state.totalTokens >= state.threshold);
}

/**
 * Returns true when a memory flush has already been performed for the current
 * compaction cycle. This prevents repeated flush runs within the same cycle —
 * important for both the token-based and transcript-size–based trigger paths.
 */
export function hasAlreadyFlushedForCurrentCompaction(
  entry: Pick<SessionEntry, "compactionCount" | "memoryFlushCompactionCount">,
): boolean {
  const compactionCount = entry.compactionCount ?? 0;
  const lastFlushAt = entry.memoryFlushCompactionCount;
  return typeof lastFlushAt === "number" && lastFlushAt === compactionCount;
}

export type CliMemoryFlushPosition = {
  fingerprint: string;
  promptTokens?: number;
  transcriptBytes?: number;
};

export type CliMemoryFlushGateDecision =
  | {
      kind: "run";
      reason: "first" | "tokens" | "bytes";
      resetFailureBudget: boolean;
    }
  | {
      kind: "rearm";
      reason: "fingerprint_changed" | "file_shrank" | "token_reset";
      receipt: CliMemoryFlushPosition;
    }
  | { kind: "adopt_fingerprint"; receipt: CliMemoryFlushPosition }
  | { kind: "wait" };

const CLI_MEMORY_FLUSH_TOKEN_RESET_HYSTERESIS = 2_000;

/**
 * Gates repeated pressure flushes for CLI runtimes that compact outside OpenClaw.
 * Positions are frozen before the maintenance run so a receipt never claims
 * context that was not present in that run's bounded transcript snapshot.
 */
export function resolveCliMemoryFlushGate(params: {
  entry: Pick<
    SessionEntry,
    "memoryFlushCliFingerprint" | "memoryFlushCliPromptTokens" | "memoryFlushCliTranscriptBytes"
  >;
  position: CliMemoryFlushPosition;
  tokenPressureDue: boolean;
  transcriptPressureDue: boolean;
  repeatAfterTokens?: number;
  repeatAfterTranscriptBytes?: number;
}): CliMemoryFlushGateDecision {
  const currentPromptTokens = resolveNonNegativeInteger(params.position.promptTokens);
  const currentTranscriptBytes = resolveNonNegativeInteger(params.position.transcriptBytes);
  const previousPromptTokens = resolveNonNegativeInteger(params.entry.memoryFlushCliPromptTokens);
  const previousTranscriptBytes = resolveNonNegativeInteger(
    params.entry.memoryFlushCliTranscriptBytes,
  );
  const previousFingerprint = params.entry.memoryFlushCliFingerprint?.trim() || undefined;
  const repeatAfterTokens = resolveNonNegativeInteger(params.repeatAfterTokens) ?? 0;
  const repeatAfterTranscriptBytes =
    resolveNonNegativeInteger(params.repeatAfterTranscriptBytes) ?? 0;
  const hasReceipt =
    previousFingerprint !== undefined ||
    previousPromptTokens !== undefined ||
    previousTranscriptBytes !== undefined;

  const currentReceipt: CliMemoryFlushPosition = {
    fingerprint: params.position.fingerprint,
    ...(currentPromptTokens !== undefined
      ? { promptTokens: currentPromptTokens }
      : previousPromptTokens !== undefined
        ? { promptTokens: previousPromptTokens }
        : {}),
    ...(currentTranscriptBytes !== undefined
      ? { transcriptBytes: currentTranscriptBytes }
      : previousTranscriptBytes !== undefined
        ? { transcriptBytes: previousTranscriptBytes }
        : {}),
  };

  const resetReason = (() => {
    if (previousFingerprint && previousFingerprint !== params.position.fingerprint) {
      return "fingerprint_changed" as const;
    }
    if (
      previousTranscriptBytes !== undefined &&
      currentTranscriptBytes !== undefined &&
      currentTranscriptBytes < previousTranscriptBytes
    ) {
      return "file_shrank" as const;
    }
    if (
      previousPromptTokens !== undefined &&
      currentPromptTokens !== undefined &&
      currentPromptTokens + CLI_MEMORY_FLUSH_TOKEN_RESET_HYSTERESIS <= previousPromptTokens
    ) {
      return "token_reset" as const;
    }
    return undefined;
  })();
  if (resetReason) {
    return { kind: "rearm", reason: resetReason, receipt: currentReceipt };
  }

  if (!hasReceipt) {
    return params.tokenPressureDue || params.transcriptPressureDue
      ? { kind: "run", reason: "first", resetFailureBudget: false }
      : { kind: "wait" };
  }

  const tokenProgressed =
    repeatAfterTokens > 0 &&
    previousPromptTokens !== undefined &&
    currentPromptTokens !== undefined &&
    currentPromptTokens >= previousPromptTokens + repeatAfterTokens;
  if (params.tokenPressureDue && tokenProgressed) {
    return { kind: "run", reason: "tokens", resetFailureBudget: true };
  }

  const transcriptProgressed =
    repeatAfterTranscriptBytes > 0 &&
    previousTranscriptBytes !== undefined &&
    currentTranscriptBytes !== undefined &&
    currentTranscriptBytes >= previousTranscriptBytes + repeatAfterTranscriptBytes;
  if (params.transcriptPressureDue && transcriptProgressed) {
    return { kind: "run", reason: "bytes", resetFailureBudget: true };
  }

  const receiptIsIncomplete =
    !previousFingerprint ||
    (previousPromptTokens === undefined && currentPromptTokens !== undefined) ||
    (previousTranscriptBytes === undefined && currentTranscriptBytes !== undefined);
  if (receiptIsIncomplete) {
    return {
      kind: "adopt_fingerprint",
      receipt: {
        fingerprint: params.position.fingerprint,
        ...(previousPromptTokens !== undefined
          ? { promptTokens: previousPromptTokens }
          : currentPromptTokens !== undefined
            ? { promptTokens: currentPromptTokens }
            : {}),
        ...(previousTranscriptBytes !== undefined
          ? { transcriptBytes: previousTranscriptBytes }
          : currentTranscriptBytes !== undefined
            ? { transcriptBytes: currentTranscriptBytes }
            : {}),
      },
    };
  }

  return { kind: "wait" };
}
