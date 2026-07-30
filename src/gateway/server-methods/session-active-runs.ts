// Session active-run helpers decide whether session operations should treat a
// session as busy based on Control UI-visible active chat/agent runs.
import { isEmbeddedAgentRunActive } from "../../agents/embedded-agent-runner/runs.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import type { GatewayRequestContext } from "./types.js";

/**
 * Active-run matcher used by session list/update methods.
 *
 * It only reports runs visible to the Control UI so background or hidden runs
 * do not make a session look busy to user-facing session operations.
 */
type TrackedActiveSessionRun = {
  sessionKey: string;
  agentId?: string;
};

function collectTrackedActiveSessionRuns(
  context: Partial<Pick<GatewayRequestContext, "chatAbortControllers">>,
  options?: { includeHidden?: boolean },
): TrackedActiveSessionRun[] {
  const runs: TrackedActiveSessionRun[] = [];
  if (!(context.chatAbortControllers instanceof Map)) {
    return runs;
  }
  for (const active of context.chatAbortControllers.values()) {
    if (
      (options?.includeHidden === true ||
        (active.projectSessionActive !== false && active.controlUiVisible !== false)) &&
      typeof active.sessionKey === "string" &&
      active.sessionKey.trim()
    ) {
      runs.push({
        sessionKey: active.sessionKey,
        agentId: typeof active.agentId === "string" ? normalizeAgentId(active.agentId) : undefined,
      });
    }
  }
  return runs;
}

function isTrackedActiveSessionRunForKey(
  active: TrackedActiveSessionRun,
  key: string,
  agentId?: string,
  defaultAgentId?: string,
): boolean {
  if (active.sessionKey !== key) {
    return false;
  }
  if (key !== "global") {
    return true;
  }
  const requestedAgentId = agentId ?? defaultAgentId;
  if (!requestedAgentId) {
    return true;
  }
  const activeAgentId = active.agentId ?? defaultAgentId;
  return activeAgentId
    ? normalizeAgentId(activeAgentId) === normalizeAgentId(requestedAgentId)
    : false;
}

/** Returns true when either requested or canonical session key has a visible active run. */
export function hasTrackedActiveSessionRun(params: {
  context: Partial<Pick<GatewayRequestContext, "chatAbortControllers">>;
  requestedKey: string;
  canonicalKey: string;
  agentId?: string;
  defaultAgentId?: string;
}): boolean {
  const activeRuns = collectTrackedActiveSessionRuns(params.context);
  return activeRuns.some(
    (active) =>
      isTrackedActiveSessionRunForKey(
        active,
        params.canonicalKey,
        params.agentId,
        params.defaultAgentId,
      ) ||
      isTrackedActiveSessionRunForKey(
        active,
        params.requestedKey,
        params.agentId,
        params.defaultAgentId,
      ),
  );
}

export function hasVisibleActiveSessionRun(params: {
  context: Partial<Pick<GatewayRequestContext, "chatAbortControllers">>;
  requestedKey: string;
  canonicalKey: string;
  sessionId?: string;
  agentId?: string;
  defaultAgentId?: string;
}): boolean {
  if (hasTrackedActiveSessionRun(params)) {
    return true;
  }
  const sessionId = params.sessionId?.trim();
  return sessionId ? isEmbeddedAgentRunActive(sessionId) : false;
}

/**
 * Returns true when any tracked run — including Control UI-hidden internal
 * runs — is writing under the session key or the row's session id. Session
 * reconciliation uses this: a live writer keeps transcript mtime ahead of the
 * registry marker, so terminal-row checks are only meaningful on quiet rows.
 */
export function hasAnyActiveSessionRunWriter(params: {
  context: Partial<Pick<GatewayRequestContext, "chatAbortControllers">>;
  sessionKey: string;
  sessionId?: string;
}): boolean {
  const activeRuns = collectTrackedActiveSessionRuns(params.context, { includeHidden: true });
  if (activeRuns.some((active) => active.sessionKey === params.sessionKey)) {
    return true;
  }
  const sessionId = params.sessionId?.trim();
  return sessionId ? isEmbeddedAgentRunActive(sessionId) : false;
}
