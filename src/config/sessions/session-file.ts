import { resolveSessionFilePath } from "./paths.js";
import type { ResolvedSessionMaintenanceConfig } from "./store-maintenance.js";
import { writeHotSessionEntry } from "./store.js";
import type { SessionEntry } from "./types.js";

export async function resolveAndPersistSessionFile(params: {
  sessionId: string;
  sessionKey: string;
  sessionStore: Record<string, SessionEntry>;
  storePath: string;
  sessionEntry?: SessionEntry;
  agentId?: string;
  sessionsDir?: string;
  fallbackSessionFile?: string;
  activeSessionKey?: string;
  maintenanceConfig?: ResolvedSessionMaintenanceConfig;
}): Promise<{ sessionFile: string; sessionEntry: SessionEntry }> {
  const { sessionId, sessionKey, sessionStore, storePath } = params;
  const baseEntry = params.sessionEntry ??
    sessionStore[sessionKey] ?? { sessionId, updatedAt: Date.now() };
  const fallbackSessionFile = params.fallbackSessionFile?.trim();
  const entryForResolve =
    !baseEntry.sessionFile && fallbackSessionFile
      ? { ...baseEntry, sessionFile: fallbackSessionFile }
      : baseEntry;
  const sessionFile = resolveSessionFilePath(sessionId, entryForResolve, {
    agentId: params.agentId,
    sessionsDir: params.sessionsDir,
  });
  const persistedEntry: SessionEntry = {
    ...baseEntry,
    sessionId,
    updatedAt: baseEntry.updatedAt ?? Date.now(),
    sessionFile,
  };
  if (baseEntry.sessionId !== sessionId || baseEntry.sessionFile !== sessionFile) {
    sessionStore[sessionKey] = persistedEntry;
    await writeHotSessionEntry({
      storePath,
      sessionKey,
      mutator: (existing) => ({
        ...existing,
        ...persistedEntry,
      }),
    });
    return { sessionFile, sessionEntry: persistedEntry };
  }
  sessionStore[sessionKey] = persistedEntry;
  return { sessionFile, sessionEntry: persistedEntry };
}
