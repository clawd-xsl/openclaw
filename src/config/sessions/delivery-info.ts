// Delivery lookup recovers routable channel context from persisted session stores.
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { normalizeChatType, type ChatType } from "../../channels/chat-type.js";
import {
  resolveSessionStoreAgentId,
  resolveSessionStoreKey,
} from "../../gateway/session-store-key.js";
import { channelRouteDedupeKey } from "../../plugin-sdk/channel-route.js";
import { requiresFoldedSessionKeyAliasProof } from "../../sessions/session-key-utils.js";
import { deliveryContextFromSession } from "../../utils/delivery-context.shared.js";
import { getRuntimeConfig } from "../io.js";
import type { OpenClawConfig } from "../types.openclaw.js";
import { resolveStorePath } from "./paths.js";
import {
  foldedSessionKeyAliasCandidates,
  hasMismatchedCaseSensitiveDeliveryProof,
  isConfirmedLowercasedLegacyAlias,
  normalizeStoreSessionKey,
} from "./store-entry.js";
import { readSessionStoreSnapshot } from "./store.js";
import { resolveAllAgentSessionStoreTargetsSync } from "./targets.js";
import { parseSessionThreadInfo } from "./thread-info.js";
import type { SessionEntry } from "./types.js";

function hasRoutableDeliveryContext(context?: {
  channel?: string;
  to?: string;
  accountId?: string;
  threadId?: string | number;
}): context is {
  channel: string;
  to: string;
  accountId?: string;
  threadId?: string | number;
} {
  return Boolean(context?.channel && context?.to);
}

// Persisted routes mix bare targets (inbound) with channel-prefixed ones that
// older outbound announces wrote (e.g. origin.to "signal:<uuid>"). Fold the
// channel prefix before route-identity comparison so owner identity restore
// keeps working for entries written by either spelling.
function stripChannelPrefixFromTarget(
  to: string | undefined,
  channel: string | undefined,
): string | undefined {
  const target = to?.trim();
  const prefix = normalizeLowercaseStringOrEmpty(channel ?? "");
  if (!target || !prefix) {
    return target;
  }
  return normalizeLowercaseStringOrEmpty(target).startsWith(`${prefix}:`)
    ? target.slice(prefix.length + 1).trim()
    : target;
}

/**
 * Extracts the routable delivery context and thread id for a persisted session key.
 *
 * Thread/topic keys first try their exact store entry, then fall back to the base session when
 * the thread entry has no delivery route of its own.
 */
export function extractDeliveryInfo(
  sessionKey: string | undefined,
  options?: { cfg?: OpenClawConfig },
): {
  deliveryContext:
    | { channel?: string; to?: string; accountId?: string; threadId?: string | number }
    | undefined;
  threadId: string | undefined;
  chatType?: ChatType;
  senderId?: string;
} {
  const { baseSessionKey, threadId } = parseSessionThreadInfo(sessionKey);
  if (!sessionKey || !baseSessionKey) {
    return { deliveryContext: undefined, threadId };
  }

  let deliveryContext:
    | { channel?: string; to?: string; accountId?: string; threadId?: string | number }
    | undefined;
  let chatType: ChatType | undefined;
  let senderId: string | undefined;
  try {
    const cfg = options?.cfg ?? getRuntimeConfig();
    const lookup = loadDeliverySessionEntry({ cfg, sessionKey, baseSessionKey });
    let entry = lookup.entry;
    let storedDeliveryContext = deliveryContextFromSession(entry);
    if (!hasRoutableDeliveryContext(storedDeliveryContext) && baseSessionKey !== sessionKey) {
      entry = lookup.baseEntry;
      storedDeliveryContext = deliveryContextFromSession(entry);
    }
    if (hasRoutableDeliveryContext(storedDeliveryContext)) {
      deliveryContext = {
        channel: storedDeliveryContext.channel,
        to: storedDeliveryContext.to,
        accountId: storedDeliveryContext.accountId,
        threadId: storedDeliveryContext.threadId,
      };
      chatType = normalizeChatType(
        entry?.route?.target?.chatType ?? entry?.chatType ?? entry?.origin?.chatType,
      );
      const originRouteKey = channelRouteDedupeKey({
        channel: entry?.origin?.provider,
        to: stripChannelPrefixFromTarget(entry?.origin?.to, entry?.origin?.provider),
        accountId: entry?.origin?.accountId,
        threadId: entry?.origin?.threadId,
      });
      const deliveryRouteKey = channelRouteDedupeKey({
        ...storedDeliveryContext,
        to: stripChannelPrefixFromTarget(storedDeliveryContext.to, storedDeliveryContext.channel),
        threadId: threadId ?? storedDeliveryContext.threadId,
      });
      // Origin owns the sender identity. Require its complete route to match the
      // selected delivery route before exposing that identity to authorization.
      if (originRouteKey === deliveryRouteKey) {
        senderId =
          normalizeOptionalString(entry?.origin?.nativeDirectUserId) ??
          normalizeOptionalString(entry?.origin?.from);
      }
    }
  } catch {
    // ignore: best-effort
  }
  return {
    deliveryContext,
    threadId,
    ...(chatType ? { chatType } : {}),
    ...(senderId ? { senderId } : {}),
  };
}

function resolveDeliveryStorePaths(cfg: OpenClawConfig, agentId: string): string[] {
  const paths = new Set<string>();
  paths.add(resolveStorePath(cfg.session?.store, { agentId }));
  // Delivery can be restored from any resolved agent target; store order keeps the configured
  // primary path first while still covering per-agent stores.
  for (const target of resolveAllAgentSessionStoreTargetsSync(cfg)) {
    if (target.agentId === agentId) {
      paths.add(target.storePath);
    }
  }
  return [...paths];
}

function asSessionEntry(entry: unknown): SessionEntry | undefined {
  return entry as SessionEntry | undefined;
}

function findSessionEntryInStore(
  store: ReturnType<typeof readSessionStoreSnapshot>,
  keys: readonly string[],
) {
  let normalizedIndex: Map<string, SessionEntry> | undefined;
  let bestEntry: SessionEntry | undefined;
  let bestUpdatedAt = 0;
  let bestRoutable = false;
  let bestExact = false;
  // Preference order: routable delivery context first; then Matrix/tail-preserved
  // exact keys over folded aliases; then freshness. Ordinary lowercase-canonical
  // channels keep the previous freshest-routable alias behavior.
  const acceptCandidate = (candidate: unknown, isExact = false) => {
    if (!candidate) {
      return;
    }
    const entry = candidate as SessionEntry;
    const candidateRoutable = hasRoutableDeliveryContext(deliveryContextFromSession(entry));
    const candidateUpdatedAt = entry.updatedAt ?? 0;
    if (
      !bestEntry ||
      (candidateRoutable && !bestRoutable) ||
      (candidateRoutable === bestRoutable && isExact && !bestExact) ||
      (candidateRoutable === bestRoutable &&
        isExact === bestExact &&
        candidateUpdatedAt > bestUpdatedAt)
    ) {
      bestEntry = entry;
      bestUpdatedAt = candidateUpdatedAt;
      bestRoutable = candidateRoutable;
      bestExact = isExact;
    }
  };
  for (const key of keys) {
    const trimmed = key.trim();
    const normalized = normalizeStoreSessionKey(key);
    const foldedLegacyKeys = foldedSessionKeyAliasCandidates(normalized);
    const exactKeyWins = requiresFoldedSessionKeyAliasProof(normalized);
    let foundRoutableCandidate = false;
    if (
      Object.hasOwn(store, normalized) &&
      !hasMismatchedCaseSensitiveDeliveryProof(asSessionEntry(store[normalized]), normalized)
    ) {
      foundRoutableCandidate ||= hasRoutableDeliveryContext(
        deliveryContextFromSession(asSessionEntry(store[normalized])),
      );
      acceptCandidate(store[normalized], exactKeyWins);
    }
    for (const foldedLegacyKey of foldedLegacyKeys) {
      if (
        !Object.hasOwn(store, foldedLegacyKey) ||
        !isConfirmedLowercasedLegacyAlias(asSessionEntry(store[foldedLegacyKey]), normalized)
      ) {
        continue;
      }
      const foldedLegacyEntry = asSessionEntry(store[foldedLegacyKey]);
      foundRoutableCandidate ||= hasRoutableDeliveryContext(
        deliveryContextFromSession(foldedLegacyEntry),
      );
      acceptCandidate(foldedLegacyEntry);
    }
    if (
      trimmed !== normalized &&
      Object.hasOwn(store, trimmed) &&
      !hasMismatchedCaseSensitiveDeliveryProof(asSessionEntry(store[trimmed]), normalized)
    ) {
      foundRoutableCandidate ||= hasRoutableDeliveryContext(
        deliveryContextFromSession(asSessionEntry(store[trimmed])),
      );
      acceptCandidate(store[trimmed]);
    }
    if (trimmed !== normalized || !foundRoutableCandidate) {
      // Build the normalized index only after direct/exact probes fail; large session stores can
      // stay on the cheap path when the queried key already has routable delivery context.
      normalizedIndex ??= buildFreshestSessionEntryIndex(store);
      const freshest = normalizedIndex.get(normalized);
      if (!hasMismatchedCaseSensitiveDeliveryProof(freshest, normalized)) {
        acceptCandidate(freshest);
      }
      for (const foldedLegacyKey of foldedLegacyKeys) {
        const foldedFreshest = normalizedIndex.get(foldedLegacyKey);
        if (isConfirmedLowercasedLegacyAlias(foldedFreshest, normalized)) {
          acceptCandidate(foldedFreshest);
        }
      }
    }
  }
  return bestEntry;
}

function buildFreshestSessionEntryIndex(
  store: Readonly<Record<string, unknown>>,
): Map<string, SessionEntry> {
  const index = new Map<string, SessionEntry>();
  for (const [key, candidate] of Object.entries(store)) {
    const entry = asSessionEntry(candidate);
    if (!entry) {
      continue;
    }
    const normalized = normalizeStoreSessionKey(key);
    const existing = index.get(normalized);
    const entryRoutable = hasRoutableDeliveryContext(deliveryContextFromSession(entry));
    const existingRoutable = hasRoutableDeliveryContext(deliveryContextFromSession(existing));
    if (
      !existing ||
      (entryRoutable && !existingRoutable) ||
      (entryRoutable === existingRoutable && (entry.updatedAt ?? 0) > (existing.updatedAt ?? 0))
    ) {
      index.set(normalized, entry);
    }
    // Lowercase aliases are only indexed when case folding is not proof-sensitive; Matrix-style
    // opaque ids must keep exact-case delivery evidence.
    const foldedLegacyKey = normalizeLowercaseStringOrEmpty(normalized);
    if (foldedLegacyKey === normalized || requiresFoldedSessionKeyAliasProof(normalized)) {
      continue;
    }
    const foldedExisting = index.get(foldedLegacyKey);
    const foldedExistingRoutable = hasRoutableDeliveryContext(
      deliveryContextFromSession(foldedExisting),
    );
    if (
      !foldedExisting ||
      (entryRoutable && !foldedExistingRoutable) ||
      (entryRoutable === foldedExistingRoutable &&
        (entry.updatedAt ?? 0) > (foldedExisting.updatedAt ?? 0))
    ) {
      index.set(foldedLegacyKey, entry);
    }
  }
  return index;
}

function loadDeliverySessionEntry(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  baseSessionKey: string;
}) {
  const canonicalKey = resolveSessionStoreKey({
    cfg: params.cfg,
    sessionKey: params.sessionKey,
  });
  const canonicalBaseKey = resolveSessionStoreKey({
    cfg: params.cfg,
    sessionKey: params.baseSessionKey,
  });
  const agentId = resolveSessionStoreAgentId(params.cfg, canonicalKey);
  const sessionKeys = [params.sessionKey, canonicalKey];
  const baseKeys = [params.baseSessionKey, canonicalBaseKey];
  let fallback:
    | {
        entry: ReturnType<typeof findSessionEntryInStore>;
        baseEntry: ReturnType<typeof findSessionEntryInStore>;
      }
    | undefined;
  for (const storePath of resolveDeliveryStorePaths(params.cfg, agentId)) {
    const store = readSessionStoreSnapshot(storePath);
    const entry = findSessionEntryInStore(store, sessionKeys);
    const baseEntry = findSessionEntryInStore(store, baseKeys);
    if (!entry && !baseEntry) {
      continue;
    }
    fallback ??= { entry, baseEntry };
    // Prefer the first store that can actually route delivery; keep a non-routable fallback only
    // so callers can still inspect thread ids when no target-bearing session exists.
    if (
      hasRoutableDeliveryContext(deliveryContextFromSession(entry)) ||
      hasRoutableDeliveryContext(deliveryContextFromSession(baseEntry))
    ) {
      return { entry, baseEntry };
    }
  }
  return fallback ?? { entry: undefined, baseEntry: undefined };
}
