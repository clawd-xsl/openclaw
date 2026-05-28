import crypto from "node:crypto";
import type {
  CliCompactionOverlay,
  CliSessionBinding,
  CliSessionUsageSnapshot,
  SessionEntry,
} from "../config/sessions.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import { normalizeProviderId } from "./model-selection.js";

const CLAUDE_CLI_BACKEND_ID = "claude-cli";

export type CliSessionInvalidationReason = "auth-profile" | "auth-epoch" | "system-prompt" | "mcp";

export type CliSessionContinuityBreakReason = CliSessionInvalidationReason | "session_expired";

export class CliSessionContinuityError extends Error {
  readonly provider: string;
  readonly reason: CliSessionContinuityBreakReason;
  readonly previousCliSessionId?: string;

  constructor(params: {
    provider: string;
    reason: CliSessionContinuityBreakReason;
    previousCliSessionId?: string;
  }) {
    super(`CLI session continuity lost for ${params.provider}: ${params.reason}`);
    this.name = "CliSessionContinuityError";
    this.provider = params.provider;
    this.reason = params.reason;
    this.previousCliSessionId = normalizeOptionalString(params.previousCliSessionId);
  }
}

export function isCliSessionContinuityError(err: unknown): err is CliSessionContinuityError {
  if (err instanceof CliSessionContinuityError) {
    return true;
  }
  if (!err || typeof err !== "object") {
    return false;
  }
  const candidate = err as {
    name?: unknown;
    provider?: unknown;
    reason?: unknown;
  };
  return (
    candidate.name === "CliSessionContinuityError" &&
    typeof candidate.provider === "string" &&
    typeof candidate.reason === "string"
  );
}

export function hashCliSessionText(value: string | undefined): string | undefined {
  const trimmed = normalizeOptionalString(value);
  if (!trimmed) {
    return undefined;
  }
  return crypto.createHash("sha256").update(trimmed).digest("hex");
}

function normalizePositiveInteger(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined;
}

function normalizeCliSessionUsageSnapshot(
  usage: CliSessionUsageSnapshot | undefined,
): CliSessionUsageSnapshot | undefined {
  if (!usage) {
    return undefined;
  }
  const input = normalizePositiveInteger(usage.input);
  const output = normalizePositiveInteger(usage.output);
  const cacheRead = normalizePositiveInteger(usage.cacheRead);
  const cacheWrite = normalizePositiveInteger(usage.cacheWrite);
  const total = normalizePositiveInteger(usage.total);
  if (!input && !output && !cacheRead && !cacheWrite && !total) {
    return undefined;
  }
  const updatedAt =
    typeof usage.updatedAt === "number" && Number.isFinite(usage.updatedAt) && usage.updatedAt > 0
      ? Math.floor(usage.updatedAt)
      : Date.now();
  return {
    ...(input ? { input } : {}),
    ...(output ? { output } : {}),
    ...(cacheRead ? { cacheRead } : {}),
    ...(cacheWrite ? { cacheWrite } : {}),
    ...(total ? { total } : {}),
    updatedAt,
  };
}

export function getCliSessionBinding(
  entry: SessionEntry | undefined,
  provider: string,
): CliSessionBinding | undefined {
  if (!entry) {
    return undefined;
  }
  const normalized = normalizeProviderId(provider);
  const fromBindings = entry.cliSessionBindings?.[normalized];
  const bindingSessionId = normalizeOptionalString(fromBindings?.sessionId);
  if (bindingSessionId) {
    const lastUsage = normalizeCliSessionUsageSnapshot(fromBindings?.lastUsage);
    return {
      sessionId: bindingSessionId,
      authProfileId: normalizeOptionalString(fromBindings?.authProfileId),
      authEpoch: normalizeOptionalString(fromBindings?.authEpoch),
      extraSystemPromptHash: normalizeOptionalString(fromBindings?.extraSystemPromptHash),
      mcpConfigHash: normalizeOptionalString(fromBindings?.mcpConfigHash),
      ...(lastUsage ? { lastUsage } : {}),
    };
  }
  const fromMap = entry.cliSessionIds?.[normalized];
  const normalizedFromMap = normalizeOptionalString(fromMap);
  if (normalizedFromMap) {
    return { sessionId: normalizedFromMap };
  }
  if (normalized === CLAUDE_CLI_BACKEND_ID) {
    const legacy = normalizeOptionalString(entry.claudeCliSessionId);
    if (legacy) {
      return { sessionId: legacy };
    }
  }
  return undefined;
}

export function getCliSessionId(
  entry: SessionEntry | undefined,
  provider: string,
): string | undefined {
  return getCliSessionBinding(entry, provider)?.sessionId;
}

export function setCliSessionId(entry: SessionEntry, provider: string, sessionId: string): void {
  setCliSessionBinding(entry, provider, { sessionId });
}

export function setCliSessionBinding(
  entry: SessionEntry,
  provider: string,
  binding: CliSessionBinding,
): void {
  const normalized = normalizeProviderId(provider);
  const trimmed = binding.sessionId.trim();
  if (!trimmed) {
    return;
  }
  const lastUsage = normalizeCliSessionUsageSnapshot(binding.lastUsage);
  entry.cliSessionBindings = {
    ...entry.cliSessionBindings,
    [normalized]: {
      sessionId: trimmed,
      ...(normalizeOptionalString(binding.authProfileId)
        ? { authProfileId: normalizeOptionalString(binding.authProfileId) }
        : {}),
      ...(normalizeOptionalString(binding.authEpoch)
        ? { authEpoch: normalizeOptionalString(binding.authEpoch) }
        : {}),
      ...(normalizeOptionalString(binding.extraSystemPromptHash)
        ? { extraSystemPromptHash: normalizeOptionalString(binding.extraSystemPromptHash) }
        : {}),
      ...(normalizeOptionalString(binding.mcpConfigHash)
        ? { mcpConfigHash: normalizeOptionalString(binding.mcpConfigHash) }
        : {}),
      ...(lastUsage ? { lastUsage } : {}),
    },
  };
  entry.cliSessionIds = { ...entry.cliSessionIds, [normalized]: trimmed };
  if (normalized === CLAUDE_CLI_BACKEND_ID) {
    entry.claudeCliSessionId = trimmed;
  }
}

export function clearCliSession(entry: SessionEntry, provider: string): void {
  const normalized = normalizeProviderId(provider);
  if (entry.cliSessionBindings?.[normalized] !== undefined) {
    const next = { ...entry.cliSessionBindings };
    delete next[normalized];
    entry.cliSessionBindings = Object.keys(next).length > 0 ? next : undefined;
  }
  if (entry.cliSessionIds?.[normalized] !== undefined) {
    const next = { ...entry.cliSessionIds };
    delete next[normalized];
    entry.cliSessionIds = Object.keys(next).length > 0 ? next : undefined;
  }
  if (normalized === CLAUDE_CLI_BACKEND_ID) {
    delete entry.claudeCliSessionId;
  }
}

export function clearAllCliSessions(entry: SessionEntry): void {
  delete entry.cliSessionBindings;
  delete entry.cliSessionIds;
  delete entry.claudeCliSessionId;
}

export function getCliCompactionOverlay(
  entry: SessionEntry | undefined,
  provider: string,
): CliCompactionOverlay | undefined {
  if (!entry) {
    return undefined;
  }
  const normalized = normalizeProviderId(provider);
  const overlay = entry.cliCompactionOverlays?.[normalized];
  if (!overlay) {
    return undefined;
  }
  const summary = normalizeOptionalString(overlay.summary);
  if (!summary) {
    return undefined;
  }
  return {
    provider: normalized,
    summary,
    ...(normalizeOptionalString(overlay.firstKeptEntryId)
      ? { firstKeptEntryId: normalizeOptionalString(overlay.firstKeptEntryId) }
      : {}),
    ...(normalizeOptionalString(overlay.compactionModel)
      ? { compactionModel: normalizeOptionalString(overlay.compactionModel) }
      : {}),
    ...(typeof overlay.compactedAtPromptTokens === "number" &&
    Number.isFinite(overlay.compactedAtPromptTokens) &&
    overlay.compactedAtPromptTokens > 0
      ? { compactedAtPromptTokens: Math.floor(overlay.compactedAtPromptTokens) }
      : {}),
    ...(typeof overlay.tokensBefore === "number" &&
    Number.isFinite(overlay.tokensBefore) &&
    overlay.tokensBefore > 0
      ? { tokensBefore: Math.floor(overlay.tokensBefore) }
      : {}),
    ...(typeof overlay.tokensAfter === "number" &&
    Number.isFinite(overlay.tokensAfter) &&
    overlay.tokensAfter > 0
      ? { tokensAfter: Math.floor(overlay.tokensAfter) }
      : {}),
    ...(typeof overlay.contextWindowTokens === "number" &&
    Number.isFinite(overlay.contextWindowTokens) &&
    overlay.contextWindowTokens > 0
      ? { contextWindowTokens: Math.floor(overlay.contextWindowTokens) }
      : {}),
    ...(typeof overlay.thresholdTokens === "number" &&
    Number.isFinite(overlay.thresholdTokens) &&
    overlay.thresholdTokens > 0
      ? { thresholdTokens: Math.floor(overlay.thresholdTokens) }
      : {}),
    createdAt:
      typeof overlay.createdAt === "number" && Number.isFinite(overlay.createdAt)
        ? Math.floor(overlay.createdAt)
        : Date.now(),
    updatedAt:
      typeof overlay.updatedAt === "number" && Number.isFinite(overlay.updatedAt)
        ? Math.floor(overlay.updatedAt)
        : Date.now(),
  };
}

export function setCliCompactionOverlay(
  entry: SessionEntry,
  provider: string,
  overlay: CliCompactionOverlay,
): void {
  const normalized = normalizeProviderId(provider);
  const summary = overlay.summary.trim();
  if (!summary) {
    return;
  }
  entry.cliCompactionOverlays = {
    ...entry.cliCompactionOverlays,
    [normalized]: {
      provider: normalized,
      summary,
      ...(normalizeOptionalString(overlay.firstKeptEntryId)
        ? { firstKeptEntryId: normalizeOptionalString(overlay.firstKeptEntryId) }
        : {}),
      ...(normalizeOptionalString(overlay.compactionModel)
        ? { compactionModel: normalizeOptionalString(overlay.compactionModel) }
        : {}),
      ...(typeof overlay.compactedAtPromptTokens === "number" &&
      Number.isFinite(overlay.compactedAtPromptTokens) &&
      overlay.compactedAtPromptTokens > 0
        ? { compactedAtPromptTokens: Math.floor(overlay.compactedAtPromptTokens) }
        : {}),
      ...(typeof overlay.tokensBefore === "number" &&
      Number.isFinite(overlay.tokensBefore) &&
      overlay.tokensBefore > 0
        ? { tokensBefore: Math.floor(overlay.tokensBefore) }
        : {}),
      ...(typeof overlay.tokensAfter === "number" &&
      Number.isFinite(overlay.tokensAfter) &&
      overlay.tokensAfter > 0
        ? { tokensAfter: Math.floor(overlay.tokensAfter) }
        : {}),
      ...(typeof overlay.contextWindowTokens === "number" &&
      Number.isFinite(overlay.contextWindowTokens) &&
      overlay.contextWindowTokens > 0
        ? { contextWindowTokens: Math.floor(overlay.contextWindowTokens) }
        : {}),
      ...(typeof overlay.thresholdTokens === "number" &&
      Number.isFinite(overlay.thresholdTokens) &&
      overlay.thresholdTokens > 0
        ? { thresholdTokens: Math.floor(overlay.thresholdTokens) }
        : {}),
      createdAt: Math.floor(overlay.createdAt),
      updatedAt: Math.floor(overlay.updatedAt),
    },
  };
}

export function clearCliCompactionOverlay(entry: SessionEntry, provider: string): void {
  const normalized = normalizeProviderId(provider);
  if (entry.cliCompactionOverlays?.[normalized] !== undefined) {
    const next = { ...entry.cliCompactionOverlays };
    delete next[normalized];
    entry.cliCompactionOverlays = Object.keys(next).length > 0 ? next : undefined;
  }
}

export function clearAllCliCompactionOverlays(entry: SessionEntry): void {
  delete entry.cliCompactionOverlays;
}

export function resolveCliSessionReuse(params: {
  binding?: CliSessionBinding;
  authProfileId?: string;
  authEpoch?: string;
  extraSystemPromptHash?: string;
  mcpConfigHash?: string;
}): {
  sessionId?: string;
  invalidatedReason?: CliSessionInvalidationReason;
} {
  const binding = params.binding;
  const sessionId = normalizeOptionalString(binding?.sessionId);
  if (!sessionId) {
    return {};
  }
  const currentAuthProfileId = normalizeOptionalString(params.authProfileId);
  const currentAuthEpoch = normalizeOptionalString(params.authEpoch);
  const currentExtraSystemPromptHash = normalizeOptionalString(params.extraSystemPromptHash);
  const currentMcpConfigHash = normalizeOptionalString(params.mcpConfigHash);
  const storedAuthProfileId = normalizeOptionalString(binding?.authProfileId);
  if (storedAuthProfileId !== currentAuthProfileId) {
    return { invalidatedReason: "auth-profile" };
  }
  const storedAuthEpoch = normalizeOptionalString(binding?.authEpoch);
  if (storedAuthEpoch !== currentAuthEpoch) {
    return { invalidatedReason: "auth-epoch" };
  }
  const storedExtraSystemPromptHash = normalizeOptionalString(binding?.extraSystemPromptHash);
  // Some callers persist prompt hashes only for observability. Treat an
  // omitted current hash as "do not use prompt bytes for continuity checks".
  if (
    currentExtraSystemPromptHash !== undefined &&
    storedExtraSystemPromptHash !== currentExtraSystemPromptHash
  ) {
    return { invalidatedReason: "system-prompt" };
  }
  const storedMcpConfigHash = normalizeOptionalString(binding?.mcpConfigHash);
  if (storedMcpConfigHash !== currentMcpConfigHash) {
    return { invalidatedReason: "mcp" };
  }
  return { sessionId };
}
