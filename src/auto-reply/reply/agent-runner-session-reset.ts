import fs from "node:fs";
import { clearBootstrapSnapshotOnSessionRollover } from "../../agents/bootstrap-cache.js";
import { clearAllCliSessions } from "../../agents/cli-session.js";
import { resetRegisteredAgentHarnessSessions } from "../../agents/harness/registry.js";
import { disposeSessionMcpRuntime } from "../../agents/pi-bundle-mcp-tools.js";
import type { SessionEntry } from "../../config/sessions.js";
import {
  ensureSessionHeader,
  resolveAgentIdFromSessionKey,
  resolveSessionFilePath,
  resolveSessionFilePathOptions,
  resolveSessionTranscriptPath,
  resolveSessionTranscriptPathInDir,
  updateSessionStore,
} from "../../config/sessions.js";
import { generateSecureUuid } from "../../infra/secure-random.js";
import { getGlobalHookRunner } from "../../plugins/hook-runner-global.js";
import type { PluginHookSessionEndReason } from "../../plugins/hook-types.js";
import { defaultRuntime } from "../../runtime.js";
import {
  buildSessionHistorySection,
  loadRecentSummaries,
} from "../../sessions/session-summary-loader.js";
import { generateSessionSummary } from "../../sessions/session-summary.js";
import { refreshQueuedFollowupSession, type FollowupRun } from "./queue.js";
import { buildSessionEndHookPayload, buildSessionStartHookPayload } from "./session-hooks.js";

type ResetSessionOptions = {
  failureLabel: string;
  buildLogMessage: (nextSessionId: string) => string;
  cleanupTranscripts?: boolean;
  promoteToSessionRollover?: boolean;
  rolloverReason?: PluginHookSessionEndReason;
};

const deps = {
  generateSecureUuid,
  updateSessionStore,
  refreshQueuedFollowupSession,
  now: () => Date.now(),
  archiveStableSessionTranscript: async (params: {
    sessionId: string;
    storePath: string;
    sessionFile?: string;
    agentId?: string;
  }) => {
    const { archiveSessionTranscriptsDetailed, resolveStableSessionEndTranscript } =
      await import("../../gateway/session-archive.runtime.js");
    const archivedTranscripts = archiveSessionTranscriptsDetailed({
      sessionId: params.sessionId,
      storePath: params.storePath,
      sessionFile: params.sessionFile,
      agentId: params.agentId,
      reason: "reset",
    });
    return resolveStableSessionEndTranscript({
      sessionId: params.sessionId,
      storePath: params.storePath,
      sessionFile: params.sessionFile,
      agentId: params.agentId,
      archivedTranscripts,
    });
  },
  generateSessionSummary,
  loadRecentSummaries,
  buildSessionHistorySection,
  disposeSessionMcpRuntime,
  resetRegisteredAgentHarnessSessions,
  clearBootstrapSnapshotOnSessionRollover,
  getHookRunner: () => getGlobalHookRunner(),
  buildSessionEndHookPayload,
  buildSessionStartHookPayload,
  ensureSessionHeader,
  error: (message: string) => defaultRuntime.error(message),
  warn: (message: string) => defaultRuntime.error(message),
};

export function setAgentRunnerSessionResetTestDeps(overrides?: Partial<typeof deps>): void {
  Object.assign(deps, {
    generateSecureUuid,
    updateSessionStore,
    refreshQueuedFollowupSession,
    now: () => Date.now(),
    archiveStableSessionTranscript: async (params: {
      sessionId: string;
      storePath: string;
      sessionFile?: string;
      agentId?: string;
    }) => {
      const { archiveSessionTranscriptsDetailed, resolveStableSessionEndTranscript } =
        await import("../../gateway/session-archive.runtime.js");
      const archivedTranscripts = archiveSessionTranscriptsDetailed({
        sessionId: params.sessionId,
        storePath: params.storePath,
        sessionFile: params.sessionFile,
        agentId: params.agentId,
        reason: "reset",
      });
      return resolveStableSessionEndTranscript({
        sessionId: params.sessionId,
        storePath: params.storePath,
        sessionFile: params.sessionFile,
        agentId: params.agentId,
        archivedTranscripts,
      });
    },
    generateSessionSummary,
    loadRecentSummaries,
    buildSessionHistorySection,
    disposeSessionMcpRuntime,
    resetRegisteredAgentHarnessSessions,
    clearBootstrapSnapshotOnSessionRollover,
    getHookRunner: () => getGlobalHookRunner(),
    buildSessionEndHookPayload,
    buildSessionStartHookPayload,
    ensureSessionHeader,
    error: (message: string) => defaultRuntime.error(message),
    warn: (message: string) => defaultRuntime.error(message),
    ...overrides,
  });
}

export async function resetReplyRunSession(params: {
  options: ResetSessionOptions;
  sessionKey?: string;
  queueKey: string;
  activeSessionEntry?: SessionEntry;
  activeSessionStore?: Record<string, SessionEntry>;
  storePath?: string;
  messageThreadId?: string;
  followupRun: FollowupRun;
  onActiveSessionEntry: (entry: SessionEntry) => void;
  onNewSession: (newSessionId: string, nextSessionFile: string) => void;
}): Promise<boolean> {
  if (!params.sessionKey || !params.activeSessionStore || !params.storePath) {
    return false;
  }
  const prevEntry = params.activeSessionStore[params.sessionKey] ?? params.activeSessionEntry;
  if (!prevEntry) {
    return false;
  }
  const now = deps.now();
  const prevSessionId = params.options.cleanupTranscripts ? prevEntry.sessionId : undefined;
  const nextSessionId = deps.generateSecureUuid();
  const nextEntry: SessionEntry = {
    ...prevEntry,
    sessionId: nextSessionId,
    updatedAt: now,
    systemSent: false,
    abortedLastRun: false,
    modelProvider: undefined,
    model: undefined,
    inputTokens: undefined,
    outputTokens: undefined,
    totalTokens: undefined,
    totalTokensFresh: false,
    estimatedCostUsd: undefined,
    cacheRead: undefined,
    cacheWrite: undefined,
    contextTokens: undefined,
    systemPromptReport: undefined,
    fallbackNoticeSelectedModel: undefined,
    fallbackNoticeActiveModel: undefined,
    fallbackNoticeReason: undefined,
  };
  const agentId = resolveAgentIdFromSessionKey(params.sessionKey);
  if (params.options.promoteToSessionRollover) {
    nextEntry.compactionCount = 0;
    nextEntry.previousSessionId = prevEntry.sessionId;
    nextEntry.createdAt = now;
    nextEntry.memoryFlushCompactionCount = undefined;
    nextEntry.memoryFlushAt = undefined;
    nextEntry.memoryFlushPromptTokens = undefined;
    nextEntry.memoryFlushContextHash = undefined;
    clearAllCliSessions(nextEntry);
  }
  const sessionPathOpts = resolveSessionFilePathOptions({
    agentId,
    storePath: params.storePath,
  });
  const nextSessionFile =
    params.options.promoteToSessionRollover && sessionPathOpts?.sessionsDir
      ? resolveSessionTranscriptPathInDir(
          nextSessionId,
          sessionPathOpts.sessionsDir,
          params.messageThreadId,
        )
      : resolveSessionTranscriptPath(nextSessionId, agentId, params.messageThreadId);
  nextEntry.sessionFile = nextSessionFile;
  params.activeSessionStore[params.sessionKey] = nextEntry;
  try {
    await deps.updateSessionStore(params.storePath, (store) => {
      store[params.sessionKey!] = nextEntry;
    });
  } catch (err) {
    deps.error(
      `Failed to persist session reset after ${params.options.failureLabel} (${params.sessionKey}): ${String(err)}`,
    );
  }
  try {
    await deps.ensureSessionHeader({
      sessionFile: nextSessionFile,
      sessionId: nextSessionId,
    });
  } catch (err) {
    deps.warn(
      `Failed to initialize session transcript after ${params.options.failureLabel} (${params.sessionKey}): ${String(err)}`,
    );
  }
  params.followupRun.run.sessionId = nextSessionId;
  params.followupRun.run.sessionFile = nextSessionFile;
  if (params.options.promoteToSessionRollover) {
    params.followupRun.run.previousSessionId = prevEntry.sessionId;
    params.followupRun.run.sessionCreatedAt = now;
    params.followupRun.run.recentSessionHistory = undefined;
  }
  params.onActiveSessionEntry(nextEntry);
  params.onNewSession(nextSessionId, nextSessionFile);
  deps.error(params.options.buildLogMessage(nextSessionId));
  if (params.options.promoteToSessionRollover && prevEntry.sessionId) {
    let previousSessionTranscript: {
      sessionFile?: string;
      transcriptArchived?: boolean;
    } = {};
    deps.clearBootstrapSnapshotOnSessionRollover({
      sessionKey: params.sessionKey,
      previousSessionId: prevEntry.sessionId,
    });
    try {
      previousSessionTranscript = await deps.archiveStableSessionTranscript({
        sessionId: prevEntry.sessionId,
        storePath: params.storePath,
        sessionFile: prevEntry.sessionFile,
        agentId,
      });
    } catch (err) {
      deps.warn(
        `Failed to archive transcript while resetting ${params.sessionKey} (${params.options.failureLabel}): ${String(err)}`,
      );
    }

    const summaryTranscriptFile = previousSessionTranscript.sessionFile;
    if (summaryTranscriptFile) {
      try {
        await deps.generateSessionSummary({
          sessionFilePath: summaryTranscriptFile,
          sessionId: prevEntry.sessionId,
          previousSessionId: prevEntry.previousSessionId,
          sessionKey: params.sessionKey,
          agentId,
          config: params.followupRun.run.config,
          createdAt: prevEntry.createdAt ?? now,
          endedAt: now,
          model: prevEntry.model ?? prevEntry.modelOverride,
        });
      } catch (err) {
        deps.warn(
          `Failed to generate session summary for ${prevEntry.sessionId} after ${params.options.failureLabel}: ${String(err)}`,
        );
      }
    }

    const recentSummaries = deps.loadRecentSummaries({
      sessionKey: params.sessionKey,
      agentId,
      config: params.followupRun.run.config,
    });
    const recentSessionHistory = deps.buildSessionHistorySection(recentSummaries) || undefined;
    params.followupRun.run.recentSessionHistory = recentSessionHistory;

    try {
      await deps.disposeSessionMcpRuntime(prevEntry.sessionId);
    } catch (err) {
      deps.warn(`Failed to dispose session MCP runtime for ${prevEntry.sessionId}: ${String(err)}`);
    }
    try {
      await deps.resetRegisteredAgentHarnessSessions({
        sessionId: prevEntry.sessionId,
        sessionKey: params.sessionKey,
        sessionFile: prevEntry.sessionFile,
        reason: params.options.rolloverReason ?? "unknown",
      });
    } catch (err) {
      deps.warn(`Failed to reset harness sessions for ${prevEntry.sessionId}: ${String(err)}`);
    }

    const hookRunner = deps.getHookRunner();
    if (hookRunner?.hasHooks("session_end")) {
      const payload = deps.buildSessionEndHookPayload({
        sessionId: prevEntry.sessionId,
        sessionKey: params.sessionKey,
        cfg: params.followupRun.run.config,
        reason: params.options.rolloverReason ?? "unknown",
        sessionFile: previousSessionTranscript.sessionFile,
        transcriptArchived: previousSessionTranscript.transcriptArchived,
        nextSessionId,
        nextSessionKey: params.sessionKey,
      });
      void hookRunner.runSessionEnd(payload.event, payload.context).catch((error) => {
        deps.warn(
          `session_end hook failed during ${params.options.failureLabel}: ${String(error)}`,
        );
      });
    }
    if (hookRunner?.hasHooks("session_start")) {
      const payload = deps.buildSessionStartHookPayload({
        sessionId: nextSessionId,
        sessionKey: params.sessionKey,
        cfg: params.followupRun.run.config,
        resumedFrom: prevEntry.sessionId,
      });
      void hookRunner.runSessionStart(payload.event, payload.context).catch((error) => {
        deps.warn(
          `session_start hook failed during ${params.options.failureLabel}: ${String(error)}`,
        );
      });
    }

    deps.refreshQueuedFollowupSession({
      key: params.queueKey,
      previousSessionId: prevEntry.sessionId,
      nextSessionId,
      nextSessionFile,
      nextPreviousSessionId: prevEntry.sessionId,
      nextRecentSessionHistory: recentSessionHistory,
      nextSessionCreatedAt: now,
    });
    return true;
  }

  deps.refreshQueuedFollowupSession({
    key: params.queueKey,
    previousSessionId: prevEntry.sessionId,
    nextSessionId,
    nextSessionFile,
  });
  if (params.options.cleanupTranscripts && prevSessionId) {
    const transcriptCandidates = new Set<string>();
    const resolved = resolveSessionFilePath(
      prevSessionId,
      prevEntry,
      resolveSessionFilePathOptions({ agentId, storePath: params.storePath }),
    );
    if (resolved) {
      transcriptCandidates.add(resolved);
    }
    transcriptCandidates.add(resolveSessionTranscriptPath(prevSessionId, agentId));
    for (const candidate of transcriptCandidates) {
      try {
        fs.unlinkSync(candidate);
      } catch {
        // Best-effort cleanup.
      }
    }
  }
  return true;
}
