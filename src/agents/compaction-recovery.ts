import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import type { AgentMessage } from "@mariozechner/pi-agent-core";

const COMPACTION_RECOVERY_FILENAME = "COMPACTION.md";

export const COMPACTION_RECOVERY_CUSTOM_TYPE = "compaction-recovery";
export const MAX_COMPACTION_RECOVERY_CHARS = 8_000;

export type CompactionRecoverySessionManager = {
  appendMessage: (message: ReturnType<typeof createCompactionRecoveryMessage>) => void;
  buildSessionContext: () => { messages: AgentMessage[] };
  getCwd?: () => string;
};

export type PersistedCompactionRecoveryMarker = {
  messages: AgentMessage[];
  recoveryContentLength: number;
};

function resolveCompactionRecoveryWorkspaceDir(params: {
  workspaceDir?: string;
  sessionManager?: { getCwd?: () => string };
}): string | undefined {
  const explicitWorkspace = params.workspaceDir?.trim();
  if (explicitWorkspace) {
    return explicitWorkspace;
  }
  const sessionWorkspace = params.sessionManager?.getCwd?.();
  return typeof sessionWorkspace === "string" && sessionWorkspace.trim().length > 0
    ? sessionWorkspace
    : undefined;
}

function resolveCompactionRecoveryPath(params: {
  workspaceDir?: string;
  sessionManager?: { getCwd?: () => string };
}): string | undefined {
  const workspaceDir = resolveCompactionRecoveryWorkspaceDir(params);
  return workspaceDir ? path.join(workspaceDir, COMPACTION_RECOVERY_FILENAME) : undefined;
}

function persistCompactionRecoveryMarkerFromContent(params: {
  sessionManager: CompactionRecoverySessionManager;
  sessionId?: string;
  recoveryContent?: string;
  timestamp?: number;
}): PersistedCompactionRecoveryMarker | undefined {
  if (!params.recoveryContent) {
    return undefined;
  }
  params.sessionManager.appendMessage(
    createCompactionRecoveryMessage({
      sessionId: params.sessionId,
      recoveryContent: params.recoveryContent,
      timestamp: params.timestamp,
    }),
  );
  return {
    messages: params.sessionManager.buildSessionContext().messages,
    recoveryContentLength: params.recoveryContent.length,
  };
}

export function buildCompactionRecoveryBoundaryContent(params: {
  sessionId?: string;
  recoveryContent: string;
}): string {
  return (
    `Your conversation has just been compacted. Current session ID: ${params.sessionId ?? "unknown"}\n\n` +
    `Above this message you will see:\n` +
    `1. Compaction summary - a compressed summary of the prior conversation\n` +
    `2. Retained messages - the most recent messages preserved during compaction\n\n` +
    `Below this message is the new conversation.\n\n` +
    `Read the following compaction recovery instructions carefully to restore your state:\n\n` +
    `---\n\n` +
    params.recoveryContent.slice(0, MAX_COMPACTION_RECOVERY_CHARS)
  );
}

export function createCompactionRecoveryMessage(params: {
  sessionId?: string;
  recoveryContent: string;
  timestamp?: number;
}) {
  return {
    role: "custom" as const,
    customType: COMPACTION_RECOVERY_CUSTOM_TYPE,
    content: buildCompactionRecoveryBoundaryContent(params),
    display: false as const,
    details: undefined,
    timestamp: params.timestamp ?? Date.now(),
  };
}

export async function persistCompactionRecoveryMarker(params: {
  sessionManager: CompactionRecoverySessionManager;
  workspaceDir?: string;
  sessionId?: string;
  timestamp?: number;
}): Promise<PersistedCompactionRecoveryMarker | undefined> {
  const recoveryPath = resolveCompactionRecoveryPath(params);
  if (!recoveryPath) {
    return undefined;
  }
  const recoveryContent = await fsp
    .readFile(recoveryPath, "utf-8")
    .then((text) => text.trim())
    .catch(() => "");
  return persistCompactionRecoveryMarkerFromContent({
    sessionManager: params.sessionManager,
    sessionId: params.sessionId,
    recoveryContent: recoveryContent || undefined,
    timestamp: params.timestamp,
  });
}

export function persistCompactionRecoveryMarkerSync(params: {
  sessionManager: CompactionRecoverySessionManager;
  workspaceDir?: string;
  sessionId?: string;
  timestamp?: number;
}): PersistedCompactionRecoveryMarker | undefined {
  const recoveryPath = resolveCompactionRecoveryPath(params);
  if (!recoveryPath) {
    return undefined;
  }
  const recoveryContent = (() => {
    try {
      return fs.readFileSync(recoveryPath, "utf-8").trim();
    } catch {
      return "";
    }
  })();
  return persistCompactionRecoveryMarkerFromContent({
    sessionManager: params.sessionManager,
    sessionId: params.sessionId,
    recoveryContent: recoveryContent || undefined,
    timestamp: params.timestamp,
  });
}

export function stripTrailingRetryNoiseBeforeCompactionRecovery(
  messages: AgentMessage[],
): AgentMessage[] {
  if (messages.length < 2) {
    return messages;
  }

  const marker = messages[messages.length - 1] as {
    role?: string;
    customType?: string;
  };
  if (marker.role !== "custom" || marker.customType !== COMPACTION_RECOVERY_CUSTOM_TYPE) {
    return messages;
  }

  const trailingRetryNoise = messages[messages.length - 2] as {
    role?: string;
    stopReason?: string;
  };
  if (trailingRetryNoise.role !== "assistant" || trailingRetryNoise.stopReason !== "error") {
    return messages;
  }

  return [...messages.slice(0, -2), messages[messages.length - 1]];
}
