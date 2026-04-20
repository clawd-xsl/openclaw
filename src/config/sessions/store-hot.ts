import path from "node:path";
import { normalizeLowercaseStringOrEmpty } from "../../shared/string-coerce.js";
import { normalizeSessionRuntimeModelFields, type SessionEntry } from "./types.js";

const HOT_STORE_SUFFIX = ".hot.json";

const HOT_STORE_OMIT_KEYS = new Set<keyof SessionEntry>([
  "skillsSnapshot",
  "systemPromptReport",
  "pluginDebugEntries",
]);

export function resolveHotSessionStorePath(storePath: string): string {
  if (storePath.endsWith(".json")) {
    return storePath.slice(0, -".json".length) + HOT_STORE_SUFFIX;
  }
  return path.resolve(`${storePath}.hot.json`);
}

export function isHotSessionStorePath(storePath: string): boolean {
  return storePath.endsWith(HOT_STORE_SUFFIX);
}

export function projectSessionEntryToHot(entry: SessionEntry): SessionEntry {
  const next = { ...entry };
  for (const key of HOT_STORE_OMIT_KEYS) {
    delete next[key];
  }
  return next;
}

export function projectSessionStoreToHot(
  store: Record<string, SessionEntry>,
): Record<string, SessionEntry> {
  const projected: Record<string, SessionEntry> = {};
  for (const [sessionKey, entry] of Object.entries(store)) {
    if (!entry) {
      continue;
    }
    projected[sessionKey] = projectSessionEntryToHot(entry);
  }
  return projected;
}

export function overlayHotSessionStore(params: {
  coldStore: Record<string, SessionEntry>;
  hotStore: Record<string, SessionEntry>;
}): Record<string, SessionEntry> {
  const merged = structuredClone(params.coldStore);
  for (const [sessionKey, hotEntry] of Object.entries(params.hotStore)) {
    if (!hotEntry) {
      continue;
    }
    const normalizedKey = normalizeLowercaseStringOrEmpty(sessionKey);
    for (const existingKey of Object.keys(merged)) {
      if (existingKey === sessionKey) {
        continue;
      }
      if (normalizeLowercaseStringOrEmpty(existingKey) === normalizedKey) {
        delete merged[existingKey];
      }
    }
    const existing = merged[sessionKey];
    merged[sessionKey] = normalizeSessionRuntimeModelFields(
      existing ? { ...existing, ...hotEntry } : hotEntry,
    );
  }
  return merged;
}
