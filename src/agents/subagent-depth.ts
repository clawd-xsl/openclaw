/**
 * Subagent spawn-depth lookup helpers.
 *
 * Reads persisted session store state to recover spawn depth and parent lineage across restarts.
 */
import fs from "node:fs";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { resolveStorePath } from "../config/sessions/paths.js";
import { listSessionEntries, loadSessionEntry } from "../config/sessions/session-accessor.js";
import { isSqliteSessionStorePath } from "../config/sessions/store-sqlite.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { parseStrictNonNegativeInteger } from "../infra/parse-finite-number.js";
import { getSubagentDepth, parseAgentSessionKey } from "../sessions/session-key-utils.js";
import { parseJsonWithJson5Fallback } from "../utils/parse-json-compat.js";
import { resolveDefaultAgentId } from "./agent-scope.js";

type SessionDepthEntry = {
  sessionId?: unknown;
  spawnDepth?: unknown;
  spawnedBy?: unknown;
};

function normalizeSpawnDepth(value: unknown): number | undefined {
  if (typeof value === "number") {
    return Number.isInteger(value) && value >= 0 ? value : undefined;
  }
  if (typeof value === "string") {
    return parseStrictNonNegativeInteger(value);
  }
  return undefined;
}

function loadLegacyJsonSessionDepthStore(storePath: string): Record<string, SessionDepthEntry> {
  if (isSqliteSessionStorePath(storePath)) {
    return {};
  }
  try {
    const parsed = parseJsonWithJson5Fallback(fs.readFileSync(storePath, "utf-8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, SessionDepthEntry>;
    }
  } catch {
    // ignore missing/invalid legacy stores
  }
  return {};
}

function loadSessionDepthEntry(
  storePath: string,
  sessionKey: string,
): SessionDepthEntry | undefined {
  try {
    const entry = loadSessionEntry({
      hydrateSkillPromptRefs: false,
      sessionKey,
      storePath,
    });
    if (entry) {
      return entry;
    }
  } catch {
    // ignore missing/invalid stores
  }
  return loadLegacyJsonSessionDepthStore(storePath)[sessionKey];
}

function loadSessionDepthStore(storePath: string): Record<string, SessionDepthEntry> {
  try {
    const store = Object.fromEntries(
      listSessionEntries({ hydrateSkillPromptRefs: false, storePath }).map(
        ({ sessionKey, entry }) => [sessionKey, entry],
      ),
    );
    if (Object.keys(store).length > 0) {
      return store;
    }
  } catch {
    // ignore missing/invalid stores
  }
  return loadLegacyJsonSessionDepthStore(storePath);
}

function buildKeyCandidates(rawKey: string, cfg?: OpenClawConfig): string[] {
  if (!cfg) {
    return [rawKey];
  }
  if (rawKey === "global" || rawKey === "unknown") {
    return [rawKey];
  }
  if (parseAgentSessionKey(rawKey)) {
    return [rawKey];
  }
  const defaultAgentId = resolveDefaultAgentId(cfg);
  const prefixed = `agent:${defaultAgentId}:${rawKey}`;
  return prefixed === rawKey ? [rawKey] : [rawKey, prefixed];
}

function findEntryBySessionId(
  store: Record<string, SessionDepthEntry>,
  sessionId: string,
): SessionDepthEntry | undefined {
  const normalizedSessionId = normalizeOptionalString(sessionId);
  if (!normalizedSessionId) {
    return undefined;
  }
  for (const entry of Object.values(store)) {
    const candidateSessionId = normalizeOptionalString(entry?.sessionId);
    if (candidateSessionId && candidateSessionId === normalizedSessionId) {
      return entry;
    }
  }
  return undefined;
}

function resolveEntryForSessionKey(params: {
  sessionKey: string;
  cfg?: OpenClawConfig;
  store?: Record<string, SessionDepthEntry>;
  storeCache: Map<string, Record<string, SessionDepthEntry>>;
}): SessionDepthEntry | undefined {
  const candidates = buildKeyCandidates(params.sessionKey, params.cfg);

  if (params.store) {
    for (const key of candidates) {
      const entry = params.store[key];
      if (entry) {
        return entry;
      }
    }
    return findEntryBySessionId(params.store, params.sessionKey);
  }

  if (!params.cfg) {
    return undefined;
  }

  const storePaths: string[] = [];
  for (const key of candidates) {
    const parsed = parseAgentSessionKey(key);
    if (!parsed?.agentId) {
      continue;
    }
    const storePath = resolveStorePath(params.cfg.session?.store, { agentId: parsed.agentId });
    if (!storePaths.includes(storePath)) {
      storePaths.push(storePath);
    }
    const entry = loadSessionDepthEntry(storePath, key);
    if (entry) {
      return entry;
    }
  }

  // A few legacy callers pass a session id instead of a session key. Preserve
  // that compatibility without turning normal SQLite lineage reads into scans.
  for (const storePath of storePaths) {
    let store = params.storeCache.get(storePath);
    if (!store) {
      store = loadSessionDepthStore(storePath);
      params.storeCache.set(storePath, store);
    }
    const entry = findEntryBySessionId(store, params.sessionKey);
    if (entry) {
      return entry;
    }
  }

  return undefined;
}

export function getSubagentDepthFromSessionStore(
  sessionKey: string | undefined | null,
  opts?: {
    cfg?: OpenClawConfig;
    store?: Record<string, SessionDepthEntry>;
  },
): number {
  const raw = (sessionKey ?? "").trim();
  const fallbackDepth = getSubagentDepth(raw);
  if (!raw) {
    return fallbackDepth;
  }

  const storeCache = new Map<string, Record<string, SessionDepthEntry>>();
  const visited = new Set<string>();

  const depthFromStore = (key: string): number | undefined => {
    const normalizedKey = normalizeOptionalString(key);
    if (!normalizedKey) {
      return undefined;
    }
    if (visited.has(normalizedKey)) {
      return undefined;
    }
    visited.add(normalizedKey);

    const entry = resolveEntryForSessionKey({
      sessionKey: normalizedKey,
      cfg: opts?.cfg,
      store: opts?.store,
      storeCache,
    });

    const storedDepth = normalizeSpawnDepth(entry?.spawnDepth);
    if (storedDepth !== undefined) {
      return storedDepth;
    }

    const spawnedBy = normalizeOptionalString(entry?.spawnedBy);
    if (!spawnedBy) {
      return undefined;
    }

    const parentDepth = depthFromStore(spawnedBy);
    if (parentDepth !== undefined) {
      return parentDepth + 1;
    }

    return getSubagentDepth(spawnedBy) + 1;
  };

  return depthFromStore(raw) ?? fallbackDepth;
}
