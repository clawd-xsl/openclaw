import { loadSessionStoreFromSqlite, normalizeSessionStoreForSqlite } from "./store-sqlite.js";
import type { SessionEntry } from "./types.js";

export type LoadSessionStoreOptions = {
  skipCache?: boolean;
};

export function normalizeSessionStore(store: Record<string, SessionEntry>): void {
  normalizeSessionStoreForSqlite(store);
}

export function loadHotSessionStore(
  storePath: string,
  _opts: LoadSessionStoreOptions = {},
): Record<string, SessionEntry> {
  return loadSessionStoreFromSqlite(storePath);
}

export function loadSessionStore(
  storePath: string,
  _opts: LoadSessionStoreOptions = {},
): Record<string, SessionEntry> {
  return loadSessionStoreFromSqlite(storePath);
}
