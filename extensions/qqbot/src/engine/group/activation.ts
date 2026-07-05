// Qqbot plugin module implements activation behavior.
import { getSessionEntry, resolveStorePath } from "openclaw/plugin-sdk/session-store-runtime";

export type GroupActivationMode = "mention" | "always";

export interface SessionStoreReader {
  read(params: {
    cfg: Record<string, unknown>;
    agentId: string;
    sessionKey: string;
  }): { groupActivation?: string } | null;
}

export function resolveGroupActivation(params: {
  cfg: Record<string, unknown>;
  agentId: string;
  sessionKey: string;
  configRequireMention: boolean;
  sessionStoreReader?: SessionStoreReader;
}): GroupActivationMode {
  const fallback: GroupActivationMode = params.configRequireMention ? "mention" : "always";

  const entry = params.sessionStoreReader?.read({
    cfg: params.cfg,
    agentId: params.agentId,
    sessionKey: params.sessionKey,
  });
  if (!entry) {
    return fallback;
  }

  if (!entry?.groupActivation) {
    return fallback;
  }

  const normalized = entry.groupActivation.trim().toLowerCase();
  if (normalized === "mention" || normalized === "always") {
    return normalized;
  }
  return fallback;
}

function readConfiguredSessionStore(cfg: Record<string, unknown>): string | undefined {
  const session =
    typeof cfg.session === "object" && cfg.session !== null
      ? (cfg.session as { store?: unknown })
      : undefined;
  const rawStore = typeof session?.store === "string" ? session.store : undefined;
  return rawStore?.trim() || undefined;
}

export function createNodeSessionStoreReader(
  deps: { getSessionEntry?: typeof getSessionEntry } = {},
): SessionStoreReader {
  const readEntry = deps.getSessionEntry ?? getSessionEntry;
  return {
    read: ({ cfg, agentId, sessionKey }) => {
      try {
        const storePath = resolveStorePath(readConfiguredSessionStore(cfg), { agentId });
        return (
          readEntry({
            agentId,
            sessionKey,
            storePath,
            hydrateSkillPromptRefs: false,
          }) ?? null
        );
      } catch {
        return null;
      }
    },
  };
}
